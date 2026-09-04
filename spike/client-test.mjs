// M0 acceptance: pi's own PiClient / RemoteSession drive our server, backed by
// a real `pi --mode rpc` subprocess. Covers items 1-6 of the plan's M0 list.

import { mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import WebSocket from "ws";
import { PiClient, PiSessionOwnershipError } from "@earendil-works/pi-client";
import { RemoteSession, createTranscriptState, applyTranscriptSnapshot, applyTranscriptProgress, selectTranscript } from "@earendil-works/pi-coding-agent/client";
import { startServer } from "./server.mjs";

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const root = path.join(here, "tmp", "workspace");
mkdirSync(root, { recursive: true });
writeFileSync(path.join(root, "README.md"), "# spike workspace\n");

const log = (...a) => console.log(...a);
const results = [];
const check = (name, ok, detail = "") => { results.push([name, !!ok]); log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`); };

function wsTransport(url, token) {
  return async (handlers) => {
    const ws = new WebSocket(url, ["pi.v1"], { headers: { Authorization: `Bearer ${token}` } });
    ws.binaryType = "nodebuffer";
    await new Promise((res, rej) => { ws.once("open", res); ws.once("error", rej); });
    ws.on("message", (data) => handlers.onData(new Uint8Array(data)));
    ws.on("close", () => handlers.onClose());
    ws.on("error", (e) => handlers.onError(e));
    return {
      async send(chunk) { await new Promise((res, rej) => ws.send(chunk, { binary: true }, (e) => (e ? rej(e) : res()))); },
      close() { ws.close(); },
    };
  };
}

function waitFor(session, pred, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    if (pred(session.state)) return resolve(session.state);
    const t = setTimeout(() => { unsub(); reject(new Error(`timeout waiting for ${label}`)); }, timeoutMs);
    const unsub = session.subscribe((st) => { if (pred(st)) { clearTimeout(t); unsub(); resolve(st); } });
  });
}

function rssMb(pid) {
  if (!pid) return NaN;
  if (process.platform === "win32") {
    const out = spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { encoding: "utf8" }).stdout;
    const m = out.match(/"([\d\s ,.]+)\s?K"/); // locale-dependent thousands separators
    return m ? Math.round(Number(m[1].replace(/\D/g, "")) / 1024) : NaN;
  }
  const out = spawnSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim();
  return out ? Math.round(Number(out) / 1024) : NaN;
}

const lastText = (transcript) => {
  for (let i = transcript.length - 1; i >= 0; i--) {
    const it = transcript[i];
    if (it.role === "assistant") return it.content.filter((c) => c.type === "text").map((c) => c.text).join("");
  }
  return "";
};

async function main() {
  log("=== M0: pi-protocol server over a pi --mode rpc runner ===\n");
  const server = await startServer({ root, log: (m) => log(`  [server] ${m}`) });

  // Dialog relay: answer whatever pi asks, after a short delay so we can see that it blocked.
  const dialogLog = [];
  server.dialogs.on("request", ({ request, respond }) => {
    dialogLog.push({ at: Date.now(), method: request.method, title: request.title });
    log(`  [dialog] ${request.method}: ${request.title ?? ""} ${request.message ?? request.placeholder ?? ""}`);
    setTimeout(() => {
      if (request.method === "confirm") respond({ confirmed: true });
      else if (request.method === "input" || request.method === "select" || request.method === "editor") respond({ value: request.method === "select" ? request.options?.[0] : "42" });
    }, 500);
  });

  const client = new PiClient({ transportFactory: wsTransport(server.url, "spike") });
  const t0 = performance.now();
  const serverSnap = await client.connect();
  log(`\n1. hello: serverId=${serverSnap.serverId} models=${serverSnap.models.length} in ${Math.round(performance.now() - t0)} ms`);
  check("hello handshake with pi's PiClient", serverSnap.protocolVersion === 1 && serverSnap.models.length > 0);

  const cheap = serverSnap.models.find((m) => /haiku|mini|flash|small|lite/i.test(m.id)) ?? serverSnap.models[0];
  log(`   model: ${cheap.provider}/${cheap.id}`);

  log("\n2. create a session through RemoteSession, prompt, stream, settle");
  const tCreate = performance.now();
  const session = await RemoteSession.create(client, { cwd: ".", model: { provider: cheap.provider, id: cheap.id } });
  const sessionId = String(session["id"]); // RemoteSession.id becomes undefined after dispose()
  log(`   created ${sessionId} in ${Math.round(performance.now() - tCreate)} ms; cwd=${session.snapshot.cwd}`);
  check("create returns a snapshot the client accepts", !!session.snapshot && session.phase === "idle");

  // Our own reducer tracking, from the raw events, to prove the projector output is what pi's reducers expect.
  let mine = createTranscriptState(session.snapshot);
  let deltas = 0, progressEvents = 0, snapshots = 0;
  client.onEvent((ev) => {
    if (ev.type === "session_progress" && ev.sessionId === sessionId) { progressEvents++; if (ev.progress.type === "assistant_delta") deltas++; mine = applyTranscriptProgress(mine, ev.progress); }
    if (ev.type === "session_snapshot" && ev.snapshot.id === sessionId) { snapshots++; mine = applyTranscriptSnapshot(mine, ev.snapshot); }
  });

  const tPrompt = performance.now();
  let firstDeltaMs = null;
  const unsubFirst = client.onEvent((ev) => { if (firstDeltaMs === null && ev.type === "session_progress" && ev.progress.type === "assistant_delta") firstDeltaMs = Math.round(performance.now() - tPrompt); });
  await session.submit("Reply with exactly the single word HELLO and nothing else.");
  await waitFor(session, (st) => st.snapshot?.phase === "turn", 30_000, "turn start");
  await waitFor(session, (st) => st.snapshot?.phase === "idle", 120_000, "turn end");
  unsubFirst();
  const text1 = lastText(session.state.transcript);
  log(`   first token after ${firstDeltaMs} ms; ${deltas} deltas, ${progressEvents} progress, ${snapshots} snapshots; reply: ${JSON.stringify(text1.trim())}`);
  check("turn streamed and settled; assistant text present", /HELLO/i.test(text1), `${deltas} deltas`);
  const pi = session.state.transcript;
  const ours = selectTranscript(mine);
  const same = pi.length === ours.length && pi.every((it, i) => it.id === ours[i].id && it.role === ours[i].role);
  check("pi's RemoteSession reducer and our raw-event reducer agree", same, `${pi.length} items`);
  check("finished transcript matches authoritative snapshot", session.snapshot.transcript.length === pi.length, `${session.snapshot.transcript.length} items`);

  log("\n3. dialog relay: ask_user (input) and a shell command (confirm), both raised inside pi");
  const before = session.state.transcript.length;
  await session.submit("First, call the ask_user tool with the question 'What is your favourite number?'. Then run one shell command that prints exactly that number. Finally reply with the single word DONE.");
  await waitFor(session, (st) => st.snapshot?.phase === "turn", 30_000, "turn start");
  await waitFor(session, (st) => st.snapshot?.phase === "idle", 180_000, "turn end");
  const tools = session.state.transcript.slice(before).filter((it) => it.role === "tool");
  log(`   dialogs relayed: ${dialogLog.map((d) => d.method).join(", ")}; tool items: ${tools.map((t) => `${t.toolName}:${t.status}`).join(", ")}; reply: ${JSON.stringify(lastText(session.state.transcript).trim())}`);
  check("extension_ui_request relayed out and answered (input)", dialogLog.some((d) => d.method === "input"));
  check("extension_ui_request relayed out and answered (confirm)", dialogLog.some((d) => d.method === "confirm"));
  check("tool items projected with complete status", tools.length >= 2 && tools.every((t) => t.status === "complete" || t.status === "error"), `${tools.length} tools`);
  check("model saw the relayed answer (42)", tools.some((t) => JSON.stringify(t.content).includes("42")));

  log("\n4. abort mid-turn");
  await session.submit("Count from 1 to 400, one number per line, no commentary.");
  await waitFor(session, (st) => st.transcript.some((it) => it.role === "assistant" && it.status === "streaming"), 60_000, "streaming assistant");
  await session.abort();
  await waitFor(session, (st) => st.snapshot?.phase === "idle", 60_000, "idle after abort");
  const lastA = [...session.snapshot.transcript].reverse().find((it) => it.role === "assistant");
  check("abort settles the turn and marks the assistant item aborted", session.phase === "idle" && lastA?.status === "aborted", `status=${lastA?.status}`);

  log("\n5. measurements");
  const pid = server.runnerPid(sessionId);
  log(`   runner pid ${pid}: ~${rssMb(pid)} MB RSS after three turns`);

  log("\n6. detach, reattach via PiClient (shared lease), exclusive-lease refusal");
  const countBefore = session.snapshot.transcript.length;
  await session.dispose();
  const lease = await client.attachSession(sessionId);
  check("reattach after dispose: history intact", lease.snapshot?.transcript.length === countBefore, `${lease.snapshot?.transcript.length} items`);
  let ownership = false;
  try { await client.acquireSession(sessionId, { mode: "exclusive" }); } catch (e) { ownership = e instanceof PiSessionOwnershipError; }
  check("exclusive acquisition refused while a shared lease exists (client-side)", ownership);

  log("\n7. kill the runner mid-turn, then reattach: respawn with --session <id>");
  await lease.prompt("Without using any tools, write a 400-word story about a lighthouse keeper.");
  await new Promise((r) => setTimeout(r, 3500));
  const pidBefore = server.runnerPid(sessionId);
  server.killRunner(sessionId);
  await new Promise((r) => setTimeout(r, 1500));
  const stillAlive = Number.isFinite(rssMb(pidBefore));
  check("runner process tree is gone after kill", !stillAlive);
  await lease.dispose();
  const t2 = performance.now();
  const lease2 = await client.attachSession(sessionId);
  log(`   rehydrated in ${Math.round(performance.now() - t2)} ms; runner pid ${server.runnerPid(sessionId)}; transcript ${lease2.snapshot?.transcript.length} items`);
  check("session rehydrates from its file after a runner crash", (lease2.snapshot?.transcript.length ?? 0) >= countBefore && server.runnerPid(sessionId) !== pidBefore);
  check("re-list shows the session", (await client.listSessions()).some((s) => s.id === sessionId));

  log("\n8. error mapping: create outside the workspace root");
  let outside = null;
  try { await client.createSession({ cwd: "../../.." }); } catch (e) { outside = e; }
  check("cwd outside the root is refused with invalid_request", outside?.code === "invalid_request" || /invalid_request|outside/.test(String(outside?.message)), String(outside?.code ?? outside?.message ?? "").slice(0, 60));

  await lease2.dispose();
  await client.dispose();
  await server.close();

  const failed = results.filter(([, ok]) => !ok);
  log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch(async (e) => {
  console.error("\nSPIKE FAILED:", e);
  process.exit(1);
});
