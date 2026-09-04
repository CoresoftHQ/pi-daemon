// M0 item 3: the server half of pi-protocol, over WebSocket, backed by
// supervised `pi --mode rpc` runners. Enough to let pi's own PiClient drive it.
//
// Spike-grade: single static token, single allowed root, in-process dialog
// relay via an EventEmitter, no TLS, no tickets, no rate limits.

import http from "node:http";
import { EventEmitter } from "node:events";
import { mkdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { WebSocketServer } from "ws";
import { createClientMessageDecoder, encodeServerMessage, ProtocolValidationError, ServerMessageSchema, ServerEventSchema, SessionSnapshotSchema, TranscriptProgressSchema } from "@earendil-works/pi-protocol";
import { Value } from "typebox/value";
import { Runner } from "./runner.mjs";
import { Projector } from "./projector.mjs";

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const EXT = path.join(here, "ext", "spike-ext.ts");
const ISOLATE = ["--no-extensions", "-e", EXT, "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files"];

class ProtocolError extends Error {
  constructor(code, message, details) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

function toModelMetadata(m) {
  return {
    provider: m.provider,
    id: m.id,
    name: m.name ?? m.id,
    api: m.api ?? "unknown",
    reasoning: !!m.reasoning,
    input: Array.isArray(m.input) ? m.input.filter((x) => x === "text" || x === "image") : ["text"],
    contextWindow: Number.isInteger(m.contextWindow) ? m.contextWindow : 0,
    maxTokens: Number.isInteger(m.maxTokens) ? m.maxTokens : 0,
    cost: { input: m.cost?.input ?? 0, output: m.cost?.output ?? 0, cacheRead: m.cost?.cacheRead ?? 0, cacheWrite: m.cost?.cacheWrite ?? 0 },
    supportedThinkingLevels: m.reasoning ? ["off", "minimal", "low", "medium", "high"] : ["off"],
    authenticated: true,
  };
}

export async function startServer({ port = 0, root, token = "spike", log = () => {} }) {
  mkdirSync(root, { recursive: true });
  const canonicalRoot = realpathSync.native(root);
  const sessionDir = path.join(root, ".pi-sessions");
  mkdirSync(sessionDir, { recursive: true });

  const serverId = `spike_${randomUUID()}`;
  let serverRevision = 0;
  const dialogs = new EventEmitter();
  const connections = new Set();
  /** sessionId -> { id, cwd, createdAt, updatedAt, name?, live: null | { runner, projector, conns:Set } } */
  const sessions = new Map();

  // ---- models: probe once with a throwaway runner
  const models = [];
  {
    const probe = new Runner({ cwd: canonicalRoot, args: [...ISOLATE, "--no-tools", "--no-session"] }).start();
    const res = await probe.send({ type: "get_available_models" });
    for (const m of res.data?.models ?? []) models.push(toModelMetadata(m));
    probe.kill();
    await new Promise((r) => probe.once("exit", r));
    log(`models: ${models.length}`);
  }

  const metadata = (s) => ({ id: s.id, createdAt: s.createdAt, updatedAt: s.updatedAt, ...(s.name ? { sessionName: s.name } : {}), cwd: s.cwd });
  const serverSnapshot = () => ({ serverId, protocolVersion: 1, revision: serverRevision, sessions: [...sessions.values()].map(metadata), models });

  const sendTo = (conn, message) => {
    if (conn.ws.readyState !== conn.ws.OPEN) return;
    try {
      conn.ws.send(encodeServerMessage(message), { binary: true });
    } catch (err) {
      // Spike diagnostics: pi-protocol's error does not say which field; typebox does,
      // but only usefully against the narrowest schema, since the top level is a union.
      let schema = ServerMessageSchema, value = message;
      if (message.type === "event" && message.event?.type === "session_progress") { schema = TranscriptProgressSchema; value = message.event.progress; }
      else if (message.type === "event" && message.event?.type === "session_snapshot") { schema = SessionSnapshotSchema; value = message.event.snapshot; }
      else if (message.type === "event") { schema = ServerEventSchema; value = message.event; }
      else if (message.type === "response" && message.ok && message.result?.session) { schema = SessionSnapshotSchema; value = message.result.session; }
      const errors = [...Value.Errors(schema, value)].slice(0, 6);
      const where = errors.map((e) => `${e.path || "/"}: ${e.message}`).join(" | ");
      log(`INVALID ${message.type}${message.event ? "/" + message.event.type : ""}${message.event?.progress ? "/" + message.event.progress.type : ""}: ${where || err.message}`);
      log(`  payload: ${JSON.stringify(message).slice(0, 400)}`);
      invalid.push({ message, where });
    }
  };
  const invalid = [];
  const broadcastServer = () => {
    serverRevision += 1;
    for (const c of connections) if (c.helloDone) sendTo(c, { type: "event", event: { type: "server_snapshot", snapshot: serverSnapshot() } });
  };
  const sessionSnapshotFor = (s) => ({ ...s.live.projector.snapshot, attached: s.live.conns.size > 0, locked: false });

  function emitProjectorOutputs(s, outputs) {
    for (const o of outputs) {
      if (o.kind === "progress") {
        for (const c of s.live.conns) sendTo(c, { type: "event", event: { type: "session_progress", sessionId: s.id, progress: o.progress } });
      } else {
        s.updatedAt = Date.now();
        for (const c of s.live.conns) sendTo(c, { type: "event", event: { type: "session_snapshot", snapshot: sessionSnapshotFor(s) } });
      }
    }
  }

  async function spawnLive(s, extraArgs) {
    const runner = new Runner({ cwd: s.cwd, args: [...ISOLATE, "--session-dir", sessionDir, ...extraArgs] }).start();
    runner.on("stderr", (t) => log(`[runner ${s.id.slice(0, 8)}] ${t.trimEnd()}`));
    const state = (await runner.send({ type: "get_state" })).data;
    if (!s.id) s.id = state.sessionId;
    const projector = new Projector({ sessionId: s.id, cwd: s.cwd, state, createdAt: s.createdAt });
    const msgs = (await runner.send({ type: "get_messages" })).data.messages;
    projector.loadMessages(msgs);
    s.live = { runner, projector, conns: new Set() };
    runner.on("event", (ev) => {
      if (/^(agent_start|agent_end|agent_settled|auto_retry_start|auto_retry_end|extension_error|compaction_start|compaction_end|summarization_retry_scheduled)$/.test(ev.type)) {
        const extra = ev.type === "agent_end" ? ` willRetry=${ev.willRetry}` : ev.type === "auto_retry_start" ? ` attempt=${ev.attempt}/${ev.maxAttempts} delay=${ev.delayMs}ms ${ev.errorMessage}` : ev.type === "extension_error" ? ` ${JSON.stringify(ev).slice(0, 200)}` : "";
        log(`[runner ${s.id.slice(0, 8)}] ${ev.type}${extra}`);
      }
      if (ev.type === "agent_end") for (const m of ev.messages ?? []) if (m.role === "assistant" && m.stopReason === "error") log(`[runner ${s.id.slice(0, 8)}] assistant error: ${m.errorMessage ?? "(no message)"}`);
      if (s.live?.runner === runner) emitProjectorOutputs(s, projector.apply(ev));
    });
    runner.on("ui_request", (req) => {
      dialogs.emit("request", { sessionId: s.id, request: req, respond: (payload) => runner.respondUi(req.id, payload) });
    });
    runner.on("exit", (e) => {
      if (s.live?.runner !== runner) return;
      log(`runner for ${s.id.slice(0, 8)} exited ${JSON.stringify(e)}; session stays listable`);
      const conns = s.live.conns;
      s.live = null;
      for (const c of conns) { c.attached.delete(s.id); }
      broadcastServer();
    });
    return s;
  }

  function requireSession(sessionId) {
    const s = sessions.get(sessionId);
    if (!s) throw new ProtocolError("not_found", `unknown session ${sessionId}`);
    return s;
  }
  function requireLiveAttached(conn, sessionId) {
    const s = requireSession(sessionId);
    if (!s.live) throw new ProtocolError("not_found", `session ${sessionId} is not live; attach first`);
    if (!s.live.conns.has(conn)) throw new ProtocolError("invalid_request", `connection is not attached to ${sessionId}`);
    return s;
  }
  async function refreshState(s) {
    const state = (await s.live.runner.send({ type: "get_state" })).data;
    s.live.projector.applyState(state);
    if (state.sessionName) s.name = state.sessionName;
  }
  function rpcOk(res, what) {
    if (!res.success) {
      const msg = res.error ?? `${what} failed`;
      if (/streaming|already running|busy/i.test(msg)) throw new ProtocolError("busy", msg);
      throw new ProtocolError("invalid_request", msg);
    }
    return res;
  }

  async function handle(conn, request) {
    switch (request.command) {
      case "list":
        return { command: "list", sessions: [...sessions.values()].map(metadata) };

      case "create": {
        let cwd = canonicalRoot;
        if (request.cwd !== undefined) {
          let resolved;
          try { resolved = realpathSync.native(path.resolve(canonicalRoot, request.cwd)); } catch { throw new ProtocolError("invalid_request", "cwd does not exist", { rule: "workspace" }); }
          const rel = path.relative(canonicalRoot, resolved);
          if (rel.startsWith("..") || path.isAbsolute(rel)) throw new ProtocolError("invalid_request", "cwd is outside the registered workspace", { rule: "workspace" });
          cwd = resolved;
        }
        const s = { id: undefined, cwd, createdAt: Date.now(), updatedAt: Date.now(), live: null };
        const t0 = performance.now();
        await spawnLive(s, []);
        log(`spawned ${s.id.slice(0, 8)} in ${Math.round(performance.now() - t0)} ms`);
        sessions.set(s.id, s);
        if (request.model) { rpcOk(await s.live.runner.send({ type: "set_model", provider: request.model.provider, modelId: request.model.id }), "set_model"); }
        if (request.thinkingLevel) { rpcOk(await s.live.runner.send({ type: "set_thinking_level", level: request.thinkingLevel }), "set_thinking_level"); }
        if (request.name) { rpcOk(await s.live.runner.send({ type: "set_session_name", name: request.name }), "set_session_name"); s.name = request.name; }
        await refreshState(s);
        s.live.conns.add(conn);
        conn.attached.add(s.id);
        broadcastServer();
        return { command: "create", session: sessionSnapshotFor(s) };
      }

      case "attach": {
        const s = requireSession(request.sessionId);
        if (!s.live) {
          const t0 = performance.now();
          await spawnLive(s, ["--session", s.id]);
          log(`rehydrated ${s.id.slice(0, 8)} in ${Math.round(performance.now() - t0)} ms`);
        }
        s.live.conns.add(conn);
        conn.attached.add(s.id);
        return { command: "attach", session: sessionSnapshotFor(s) };
      }

      case "detach": {
        const s = requireSession(request.sessionId);
        s.live?.conns.delete(conn);
        conn.attached.delete(s.id);
        return { command: "detach", sessionId: s.id };
      }

      case "prompt": {
        const s = requireLiveAttached(conn, request.sessionId);
        rpcOk(await s.live.runner.send({ type: "prompt", message: request.text }), "prompt");
        return { command: "prompt", session: sessionSnapshotFor(s) };
      }
      case "steer": {
        const s = requireLiveAttached(conn, request.sessionId);
        rpcOk(await s.live.runner.send({ type: "steer", message: request.text }), "steer");
        return { command: "steer", session: sessionSnapshotFor(s) };
      }
      case "abort": {
        const s = requireLiveAttached(conn, request.sessionId);
        rpcOk(await s.live.runner.send({ type: "abort" }), "abort");
        return { command: "abort", session: sessionSnapshotFor(s) };
      }
      case "set_model": {
        const s = requireLiveAttached(conn, request.sessionId);
        rpcOk(await s.live.runner.send({ type: "set_model", provider: request.model.provider, modelId: request.model.id }), "set_model");
        await refreshState(s);
        return { command: "set_model", session: sessionSnapshotFor(s) };
      }
      case "set_thinking": {
        const s = requireLiveAttached(conn, request.sessionId);
        rpcOk(await s.live.runner.send({ type: "set_thinking_level", level: request.thinkingLevel }), "set_thinking_level");
        await refreshState(s);
        return { command: "set_thinking", session: sessionSnapshotFor(s) };
      }
      default:
        throw new ProtocolError("not_implemented", `command ${request.command} is not implemented`);
    }
  }

  // ---- transport
  const httpServer = http.createServer((_req, res) => { res.statusCode = 404; res.end(); });
  const wss = new WebSocketServer({ noServer: true, handleProtocols: (protocols) => (protocols.has("pi.v1") ? "pi.v1" : false) });

  httpServer.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url, "http://localhost");
    const auth = req.headers.authorization ?? "";
    const presented = auth.startsWith("Bearer ") ? auth.slice(7) : url.searchParams.get("token");
    if (url.pathname !== "/pi/v1/socket") { socket.write("HTTP/1.1 404 Not Found\r\n\r\n"); socket.destroy(); return; }
    if (presented !== token) { socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n"); socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  wss.on("connection", (ws) => {
    const conn = { ws, id: `conn_${randomUUID()}`, helloDone: false, attached: new Set() };
    connections.add(conn);
    const decoder = createClientMessageDecoder();
    const fail = (code, message) => { sendTo(conn, { type: "hello_error", error: { code, message } }); ws.close(); };

    ws.on("message", async (data, isBinary) => {
      if (!isBinary) { fail("invalid_request", "text frames are not part of the protocol"); return; }
      let messages;
      try { messages = decoder.push(new Uint8Array(data)); } catch (err) {
        if (err instanceof ProtocolValidationError) log(`decode: ${err.message}`);
        if (!conn.helloDone) fail("invalid_request", err.message); else ws.close();
        return;
      }
      for (const message of messages) {
        if (!conn.helloDone) {
          if (message.type !== "hello") { fail("invalid_request", "first message must be hello"); return; }
          if (message.version !== 1) { fail("version", `unsupported protocol version ${message.version}`); return; }
          conn.helloDone = true;
          sendTo(conn, { type: "hello", version: 1, connectionId: conn.id, snapshot: serverSnapshot() });
          continue;
        }
        if (message.type !== "request") continue;
        try {
          const result = await handle(conn, message.request);
          sendTo(conn, { type: "response", id: message.id, ok: true, result });
        } catch (err) {
          const code = err instanceof ProtocolError ? err.code : "internal_error";
          log(`request ${message.request.command} -> ${code}: ${err.message}`);
          sendTo(conn, { type: "response", id: message.id, ok: false, error: { code, message: err.message, ...(err.details ? { details: err.details } : {}) } });
        }
      }
    });
    ws.on("close", () => {
      connections.delete(conn);
      for (const id of conn.attached) sessions.get(id)?.live?.conns.delete(conn);
      conn.attached.clear();
    });
  });

  await new Promise((r) => httpServer.listen(port, "127.0.0.1", r));
  const bound = httpServer.address().port;
  log(`listening on ws://127.0.0.1:${bound}/pi/v1/socket`);

  return {
    port: bound,
    url: `ws://127.0.0.1:${bound}/pi/v1/socket`,
    dialogs,
    sessions,
    /** For M0 item 5: kill a runner out from under its session. */
    killRunner(sessionId) { sessions.get(sessionId)?.live?.runner.kill(); },
    runnerPid(sessionId) { return sessions.get(sessionId)?.live?.runner.pid; },
    async close() {
      for (const s of sessions.values()) s.live?.runner.kill();
      for (const c of connections) c.ws.close();
      await new Promise((r) => httpServer.close(r));
    },
  };
}
