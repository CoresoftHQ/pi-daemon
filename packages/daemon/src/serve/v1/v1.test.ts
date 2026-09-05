// Surface B end to end: pair, create, prompt with an idempotency key, stream events over
// WebSocket and SSE, answer a dialog, drive every session route, and the dual-encoding
// conformance check — the CBOR and JSON snapshots of one session carry the same transcript
// and the same revision.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import type net from "node:net";
import path from "node:path";
import type { TestContext } from "node:test";
import { after, before, test } from "node:test";
import type { EventType } from "@coresoft-hq/pi-daemon-contract";
import {
  EventEnvelope,
  EventPayloads,
  openApiDocument,
  SessionSnapshot,
} from "@coresoft-hq/pi-daemon-contract";
import type { ByteTransportFactory } from "@earendil-works/pi-client";
import { PiClient } from "@earendil-works/pi-client";
import { Value } from "typebox/value";
import WebSocket from "ws";
import type { AccessControl } from "../../access/authenticate.ts";
import { createUpgradeAuthenticator } from "../../access/authenticate.ts";
import { loadOrCreateIdentity } from "../../access/daemon-identity.ts";
import { DeviceStore } from "../../access/devices.ts";
import { createAccessRoutes } from "../../access/http.ts";
import { PairingService } from "../../access/pairing.ts";
import { ConnectTickets } from "../../access/tickets.ts";
import { tmpDir } from "../../os/paths.ts";
import type { DaemonEvent } from "../../sessions/events.ts";
import { EventLog } from "../../sessions/events.ts";
import { SessionHost } from "../../sessions/host.ts";
import type { AvailableModel } from "../../sessions/models.ts";
import { probeAvailableModels } from "../../sessions/models.ts";
import { PiProtocolServer } from "../pi-protocol/server.ts";
import { attachWebSocketListener } from "../pi-protocol/ws.ts";
import { memoryPair } from "../transport.ts";
import { singleRootResolver } from "../workspace-resolver.ts";
import { buildCapabilities } from "./capabilities.ts";
import { attachEventWebSocket, handleEventSse } from "./events.ts";
import { createV1Router } from "./routes.ts";

const FAKE = path.resolve(import.meta.dirname, "..", "..", "..", "test", "fake-pi.mjs");
const launcher = { command: process.execPath, prefix: [FAKE], source: "env" as const };
const env = { PATH: process.env.PATH ?? "" };

let root: string;
let host: SessionHost;
let models: AvailableModel[];
let access: AccessControl;
let pairing: PairingService;
let protocol: PiProtocolServer;
let httpServer: http.Server;
let eventWss: import("ws").WebSocketServer;
let protoWss: import("ws").WebSocketServer;
let base: string;
let token: string;

before(async () => {
  root = mkdtempSync(path.join(tmpDir(), "pi-daemon-v1-"));
  host = new SessionHost({ launcher, env, sweepIntervalMs: 0 });
  models = await probeAvailableModels({ cwd: root, env, launcher });
  const devices = new DeviceStore(path.join(root, "devices.json"));
  access = { devices, tickets: new ConnectTickets() };
  const identity = loadOrCreateIdentity(path.join(root, "daemon.json"), { name: "test" });
  pairing = new PairingService({ devices, daemonId: identity.id });
  const workspaces = singleRootResolver(root);
  protocol = new PiProtocolServer({ host, workspaces, models: () => models });
  const capabilities = () =>
    buildCapabilities({
      identity,
      version: "0.0.0-test",
      platform: process.platform,
      startedAt: Date.now(),
      pi: { version: "0.84.4", supported: ">=0.84.0 <0.86.0", path: null },
      maxFrameLength: 8 * 1024 * 1024,
      features: ["dialogs", "sse"],
      absent: ["worktrees", "files", "terminals"],
      limits: { maxRunners: 8 },
    });
  const events = { log: host.log, access };
  const accessRoutes = createAccessRoutes({
    access,
    pairing,
    daemon: identity,
    capabilities,
    onRevoked: (id) => protocol.closeForDevice(id),
  });
  const v1 = createV1Router({ host, workspaces, access, capabilities, version: "0.0.0-test", events });
  httpServer = http.createServer((req, res) => {
    void (async () => {
      if (await accessRoutes(req, res)) return;
      if (await v1.handle(req, res)) return;
      res
        .writeHead(404, { "content-type": "application/json" })
        .end(JSON.stringify({ error: { code: "not_found", message: "no such route" } }));
    })();
  });
  eventWss = attachEventWebSocket(httpServer, events);
  protoWss = attachWebSocketListener(httpServer, {
    server: protocol,
    authenticate: createUpgradeAuthenticator(access),
  });
  httpServer.on("upgrade", (req, socket) => {
    const p = new URL(req.url ?? "/", "http://localhost").pathname;
    if (p !== "/v1/events" && p !== "/pi/v1/socket") socket.destroy();
  });
  await new Promise<void>((r) => httpServer.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(httpServer.address() as net.AddressInfo).port}`;

  const code = pairing.issue().code;
  const r = await api("POST", "/v1/pair/redeem", { code, deviceName: "test", platform: "node" });
  token = r.body?.token as string;
});
after(async () => {
  protocol.closeAll();
  for (const c of eventWss.clients) c.terminate();
  for (const c of protoWss.clients) c.terminate();
  httpServer.closeAllConnections();
  await new Promise<void>((r) => httpServer.close(() => r()));
  await host.close();
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function api(
  method: string,
  p: string,
  body?: unknown,
  extraHeaders: Record<string, string> = {},
  auth = true,
) {
  const res = await fetch(`${base}${p}`, {
    method,
    headers: {
      ...(auth && token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
      ...extraHeaders,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return {
    status: res.status,
    headers: res.headers,
    body: text ? (JSON.parse(text) as Record<string, unknown>) : null,
  };
}

/** Collect events over the WebSocket stream until `until` is satisfied or the timeout. */
function streamUntil(
  t: TestContext,
  query: string,
  until: (events: DaemonEvent[]) => boolean,
  timeoutMs = 10_000,
): Promise<{ events: DaemonEvent[]; ws: WebSocket }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${base.replace("http", "ws")}/v1/events${query}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    t.after(() => ws.terminate());
    const events: DaemonEvent[] = [];
    const timer = setTimeout(
      () => reject(new Error(`stream timeout; saw ${events.map((e) => e.type).join(",")}`)),
      timeoutMs,
    );
    ws.on("message", (d) => {
      const e = JSON.parse(d.toString()) as DaemonEvent & { type: string };
      if (e.type === "pong") return;
      events.push(e);
      if (until(events)) {
        clearTimeout(timer);
        resolve({ events, ws });
      }
    });
    ws.on("error", reject);
  });
}

const validEvent = (e: DaemonEvent) => {
  assert.ok(Value.Check(EventEnvelope, e), `envelope: ${JSON.stringify(e).slice(0, 120)}`);
  const schema = EventPayloads[e.type as EventType];
  if (schema)
    assert.ok(
      Value.Check(schema, e.payload),
      `payload of ${e.type}: ${[...Value.Errors(schema, e.payload)].map((x) => `${(x as { instancePath?: string }).instancePath ?? "/"}: ${x.message}`).join("; ")}`,
    );
};

test("health is open; capabilities needs a token; the redeemed token works", async () => {
  assert.equal((await api("GET", "/v1/health", undefined, {}, false)).status, 200);
  assert.equal((await api("GET", "/v1/capabilities", undefined, {}, false)).status, 401);
  const caps = await api("GET", "/v1/capabilities");
  assert.equal(caps.status, 200);
  assert.equal((caps.body?.api as { version: number }).version, 1);
});

test("OpenAPI is generated from the schemas and covers the routes", () => {
  const doc = openApiDocument({ version: "0.0.0-test" });
  assert.equal(doc.openapi, "3.1.0");
  assert.ok("/v1/sessions/{id}/prompt" in doc.paths);
  assert.ok("/v1/dialogs/{id}/respond" in doc.paths);
  assert.ok(doc.components.schemas.SessionSnapshot);
});

test("create a session by workspaceId; the snapshot validates against the contract", async () => {
  assert.equal((await api("POST", "/v1/sessions", { workspaceId: "nope" })).status, 404);
  const bad = await api("POST", "/v1/sessions", { workspaceId: 42 });
  assert.equal(bad.status, 400);
  assert.equal((bad.body?.error as { code: string }).code, "invalid_body");
  const r = await api("POST", "/v1/sessions", { workspaceId: "default", name: "from-json" });
  assert.equal(r.status, 201);
  const session = r.body?.session as Record<string, unknown>;
  assert.ok(
    Value.Check(SessionSnapshot, session),
    [...Value.Errors(SessionSnapshot, session)]
      .map((e) => `${(e as { instancePath?: string }).instancePath ?? "/"}: ${e.message}`)
      .join("; "),
  );
  assert.equal(session.name, "from-json");
  assert.equal(session.workspaceId, "default");
  assert.ok(!("cwd" in session), "no path on the wire");
  const list = await api("GET", "/v1/sessions");
  assert.ok((list.body?.sessions as Array<{ id: string }>).some((s) => s.id === session.id));
});

test("prompt returns the runId; an Idempotency-Key replays the same answer; events carry the runId", async (t) => {
  const created = await api("POST", "/v1/sessions", { workspaceId: "default" });
  const id = (created.body?.session as { id: string }).id;
  const stream = streamUntil(t, `?since=0&scopes=session:${id}`, (es) =>
    es.some((e) => e.type === "session.phase" && (e.payload as { phase: string }).phase === "idle"),
  );
  const first = await api(
    "POST",
    `/v1/sessions/${id}/prompt`,
    { text: "hello json" },
    { "idempotency-key": "k1" },
  );
  assert.equal(first.status, 202);
  assert.match(String(first.body?.runId), /^run_/);
  assert.equal(first.body?.queued, false);
  const replay = await api(
    "POST",
    `/v1/sessions/${id}/prompt`,
    { text: "hello json" },
    { "idempotency-key": "k1" },
  );
  assert.equal(replay.status, 202);
  assert.deepEqual(replay.body, first.body);
  assert.equal(replay.headers.get("idempotent-replayed"), "true");
  const { events, ws } = await stream;
  t.after(() => ws.close());
  for (const e of events) validEvent(e);
  const phases = events
    .filter((e) => e.type === "session.phase")
    .map((e) => e.payload as { phase: string; runId: string });
  assert.deepEqual(
    phases.map((p) => p.phase),
    ["turn", "idle"],
  );
  assert.equal(phases[0]?.runId, first.body?.runId);
  assert.ok(events.some((e) => e.type === "transcript.item_finished"));
  const seqs = events.map((e) => e.seq);
  assert.deepEqual(
    seqs,
    [...seqs].sort((a, b) => a - b),
  );
  const snap = await api("GET", `/v1/sessions/${id}`);
  assert.equal((snap.body?.session as { transcript: unknown[] }).transcript.length, 2);
});

test("the WebSocket stream honours mutable subscriptions and since", async (t) => {
  const created = await api("POST", "/v1/sessions", { workspaceId: "default" });
  const id = (created.body?.session as { id: string }).id;
  // Subscribe to nothing at first, then add the session's scope over the open socket.
  const ws = new WebSocket(`${base.replace("http", "ws")}/v1/events?scopes=daemon`, {
    headers: { authorization: `Bearer ${token}` },
  });
  t.after(() => ws.close());
  await new Promise<void>((r) => ws.once("open", () => r()));
  const seen: DaemonEvent[] = [];
  ws.on("message", (d) => {
    const e = JSON.parse(d.toString()) as DaemonEvent;
    if ((e as { type: string }).type !== "pong") seen.push(e);
  });
  ws.send(JSON.stringify({ type: "subscribe", scopes: [`session:${id}`] }));
  await new Promise((r) => setTimeout(r, 30));
  const settled = streamUntil(t, `?since=${host.log.seq}&scopes=session:${id}`, (es) =>
    es.some((e) => e.type === "session.phase" && (e.payload as { phase: string }).phase === "idle"),
  );
  await api("POST", `/v1/sessions/${id}/prompt`, { text: "second" });
  const { ws: ws2 } = await settled;
  t.after(() => ws2.close());
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(
    seen.some((e) => e.scope === `session:${id}`),
    "subscription added over the socket delivers",
  );
  assert.ok(
    !seen.some((e) => e.scope.startsWith("session:") && e.scope !== `session:${id}`),
    "other sessions are filtered out",
  );
  ws.send(JSON.stringify({ type: "unsubscribe", scopes: [`session:${id}`] }));
  await new Promise((r) => setTimeout(r, 30));
  const before = seen.length;
  const settled2 = streamUntil(t, `?since=${host.log.seq}&scopes=session:${id}`, (es) =>
    es.some((e) => e.type === "session.phase" && (e.payload as { phase: string }).phase === "idle"),
  );
  await api("POST", `/v1/sessions/${id}/prompt`, { text: "third" });
  const { ws: ws3 } = await settled2;
  t.after(() => ws3.close());
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(seen.slice(before).filter((e) => e.scope === `session:${id}`).length, 0, "unsubscribed");
});

test("SSE: resumes by Last-Event-ID, and a stale watermark yields snapshot.required", async (t) => {
  // A tiny ring, so the gap case is reachable deterministically.
  const log = new EventLog({ maxEvents: 3 });
  for (let i = 1; i <= 6; i++) log.append("daemon", "tick", { i });
  const server = http.createServer((req, res) => {
    const outcome = req.headers.authorization === `Bearer ${token}`;
    if (!outcome) {
      res.writeHead(401).end();
      return;
    }
    handleEventSse(req, res, { log, access, keepaliveMs: 100_000 });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  t.after(
    () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  );
  const port = (server.address() as net.AddressInfo).port;
  const read = async (headers: Record<string, string>, count: number) => {
    const res = await fetch(`http://127.0.0.1:${port}/v1/events/sse`, {
      headers: { authorization: `Bearer ${token}`, ...headers },
    });
    assert.equal(res.headers.get("content-type"), "text/event-stream; charset=utf-8");
    const reader = res.body?.getReader();
    let buf = "";
    const frames: Array<{ id: string; event: string; data: DaemonEvent }> = [];
    while (frames.length < count && reader) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += Buffer.from(value).toString();
      for (const block of buf.split("\n\n").slice(0, -1)) {
        buf = buf.slice(block.length + 2);
        if (block.startsWith(":")) continue;
        const get = (k: string) =>
          block
            .split("\n")
            .find((l) => l.startsWith(`${k}: `))
            ?.slice(k.length + 2) ?? "";
        frames.push({ id: get("id"), event: get("event"), data: JSON.parse(get("data")) as DaemonEvent });
      }
    }
    await reader?.cancel();
    return frames;
  };
  const stale = await read({ "last-event-id": "1" }, 1);
  assert.equal(stale[0]?.event, "snapshot.required");
  assert.deepEqual(stale[0]?.data.payload, { watermark: 6, oldest: 4 });
  const fresh = await read({ "last-event-id": "4" }, 2);
  assert.deepEqual(
    fresh.map((f) => f.id),
    ["5", "6"],
  );
});

test("dialogs: opened on the stream, answered over HTTP, the second answer gets 409 naming the winner", async (t) => {
  const created = await api("POST", "/v1/sessions", { workspaceId: "default" });
  const id = (created.body?.session as { id: string }).id;
  const opened = streamUntil(t, `?since=${host.log.seq}&scopes=session:${id}`, (es) =>
    es.some((e) => e.type === "dialog.opened"),
  );
  await api("POST", `/v1/sessions/${id}/prompt`, { text: "please ASK" });
  const { events, ws } = await opened;
  t.after(() => ws.close());
  const dialogId = (events.find((e) => e.type === "dialog.opened")?.payload as { dialogId: string }).dialogId;
  const settled = streamUntil(t, `?since=${host.log.seq}&scopes=session:${id}`, (es) =>
    es.some((e) => e.type === "dialog.closed"),
  );
  const first = await api("POST", `/v1/dialogs/${dialogId}/respond`, { confirmed: true });
  assert.equal(first.status, 200);
  assert.equal(first.body?.resolution, "answered");
  const second = await api("POST", `/v1/dialogs/${dialogId}/respond`, { confirmed: false });
  assert.equal(second.status, 409);
  const err = second.body?.error as { code: string; resolution: string; answeredBy: string };
  assert.equal(err.code, "already_resolved");
  assert.equal(err.resolution, "answered");
  assert.ok(err.answeredBy);
  assert.equal((await api("POST", "/v1/dialogs/nope:x/respond", { confirmed: true })).status, 404);
  assert.equal((await api("POST", `/v1/dialogs/${dialogId}/respond`, { nonsense: 1 })).status, 400);
  const { ws: ws2 } = await settled;
  t.after(() => ws2.close());
});

test("every session route answers and keeps the snapshot valid", async (t) => {
  const created = await api("POST", "/v1/sessions", { workspaceId: "default" });
  const id = (created.body?.session as { id: string }).id;
  const check = async (status: number, r: Awaited<ReturnType<typeof api>>) => {
    assert.equal(r.status, status, JSON.stringify(r.body));
    if (r.body?.session) assert.ok(Value.Check(SessionSnapshot, r.body.session));
  };
  await check(200, await api("POST", `/v1/sessions/${id}/queue-mode`, { queue: "steering", mode: "all" }));
  await check(200, await api("POST", `/v1/sessions/${id}/clear-queue`));
  await check(202, await api("POST", `/v1/sessions/${id}/compact`, {}));
  await check(
    200,
    await api("POST", `/v1/sessions/${id}/model`, { model: { provider: "fake", id: "fake-1" } }),
  );
  await check(200, await api("POST", `/v1/sessions/${id}/thinking`, { thinkingLevel: "low" }));
  await check(200, await api("POST", `/v1/sessions/${id}/name`, { name: "renamed" }));
  assert.equal(((await api("GET", `/v1/sessions/${id}`)).body?.session as { name: string }).name, "renamed");
  assert.equal((await api("GET", `/v1/sessions/${id}/tree`)).status, 200);
  assert.equal((await api("GET", `/v1/sessions/${id}/stats`)).status, 200);
  assert.equal((await api("GET", `/v1/sessions/${id}/entries`)).status, 200);
  await check(200, await api("POST", `/v1/sessions/${id}/fork`, { entryId: "e1" }));
  // steer / follow-up need a running turn: the SLOW prompt keeps one open long enough.
  const settled = streamUntil(t, `?since=${host.log.seq}&scopes=session:${id}`, (es) =>
    es.some((e) => e.type === "session.phase" && (e.payload as { phase: string }).phase === "idle"),
  );
  await api("POST", `/v1/sessions/${id}/prompt`, { text: "SLOW one two three four five six seven" });
  assert.equal(
    (await api("POST", `/v1/sessions/${id}/prompt`, { text: "again" })).status,
    409,
    "busy without a queue mode",
  );
  await check(202, await api("POST", `/v1/sessions/${id}/steer`, { text: "steer" }));
  await check(202, await api("POST", `/v1/sessions/${id}/follow-up`, { text: "later" }));
  await check(200, await api("POST", `/v1/sessions/${id}/abort`));
  const { ws } = await settled;
  ws.close();
  assert.equal((await api("GET", "/v1/sessions/nope")).status, 404);
  assert.equal((await api("PUT", `/v1/sessions/${id}/name`, { name: "x" })).status, 405);
});

test("dual encoding: the CBOR and JSON snapshots of one session carry the same transcript and revision", async (t) => {
  const created = await api("POST", "/v1/sessions", { workspaceId: "default" });
  const id = (created.body?.session as { id: string }).id;
  const settled = streamUntil(t, `?since=${host.log.seq}&scopes=session:${id}`, (es) =>
    es.some((e) => e.type === "session.phase" && (e.payload as { phase: string }).phase === "idle"),
  );
  await api("POST", `/v1/sessions/${id}/prompt`, { text: "compare me" });
  const { ws } = await settled;
  t.after(() => ws.close());

  const factory: ByteTransportFactory = async (handlers) => {
    const { a, b } = memoryPair();
    protocol.attachTransport(b);
    a.onData((c) => handlers.onData(c));
    a.onClose(() => handlers.onClose());
    return { send: async (c) => a.send(c), close: () => a.close() };
  };
  const client = new PiClient({ transportFactory: factory });
  t.after(() => client.dispose().catch(() => {}));
  await client.connect();
  const lease = await client.attachSession(id);
  t.after(() => lease.dispose().catch(() => {}));
  const cbor = lease.snapshot;
  const json = (await api("GET", `/v1/sessions/${id}`)).body?.session as Record<string, unknown> & {
    revision: number;
    transcript: Array<Record<string, unknown>>;
  };
  assert.ok(cbor);
  assert.equal(json.revision, cbor?.revision, "same revision from both encoders");
  assert.deepEqual(json.transcript, cbor?.transcript, "same transcript items");
  assert.equal(json.phase, cbor?.phase);
  assert.deepEqual(json.model, cbor?.model);
});
