// Terminals over the wire (spec §5.5): open from the JSON API, attach over the WebSocket and
// get a snapshot first, type and see the bytes come back, a second client sees the same
// screen and every resize, a slow client is cut with a reason while the PTY keeps going, and
// the refusals a client degrades against.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import type net from "node:net";
import path from "node:path";
import type { TestContext } from "node:test";
import { after, before, test } from "node:test";
import WebSocket from "ws";
import { waitFor } from "../../../test/helpers.ts";
import type { AccessControl } from "../../access/authenticate.ts";
import { createUpgradeAuthenticator } from "../../access/authenticate.ts";
import { DeviceStore } from "../../access/devices.ts";
import { ConnectTickets } from "../../access/tickets.ts";
import { tmpDir } from "../../os/paths.ts";
import type { DaemonEvent } from "../../sessions/events.ts";
import { SessionHost } from "../../sessions/host.ts";
import { TerminalManager } from "../../terminals/manager.ts";
import { loadPty } from "../../terminals/pty.ts";
import { singleRootResolver } from "../workspace-resolver.ts";
import { createV1Router } from "./routes.ts";
import { attachTerminalStream } from "./terminal-stream.ts";

const FAKE = path.resolve(import.meta.dirname, "..", "..", "..", "test", "fake-pi.mjs");
const launcher = { command: process.execPath, prefix: [FAKE], source: "env" as const };
const status = loadPty().status;
const skip = status.available ? false : (status.error ?? "no PTY");
const node = (script: string) => [process.execPath, "-e", script];

let root: string;
let host: SessionHost;
let manager: TerminalManager;
let httpServer: http.Server;
let base: string;
let token: string;
const events: DaemonEvent[] = [];

before(async () => {
  root = mkdtempSync(path.join(tmpDir(), "pi-daemon-term-"));
  host = new SessionHost({ launcher, env: { PATH: process.env.PATH ?? "" }, sweepIntervalMs: 0 });
  host.log.subscribe((e) => events.push(e));
  const devices = new DeviceStore(path.join(root, "devices.json"));
  const access: AccessControl = { devices, tickets: new ConnectTickets() };
  token = devices.create({ name: "owner", platform: "test" }).token;
  manager = new TerminalManager({
    publish: (scope, type, payload) => host.log.append(scope, type, payload),
    env: { ...process.env, PI_DAEMON_TOKEN: "never-shown" },
  });
  const workspaces = singleRootResolver(root);
  const v1 = createV1Router({
    host,
    workspaces,
    terminals: manager,
    access,
    capabilities: () => {
      throw new Error("unused");
    },
    version: "0.0.0-test",
    events: { log: host.log, access },
  });
  httpServer = http.createServer((req, res) => {
    void (async () => {
      if (await v1.handle(req, res)) return;
      res.writeHead(404).end();
    })();
  });
  attachTerminalStream(httpServer, {
    manager,
    authenticate: createUpgradeAuthenticator(access),
    maxBufferedBytes: 64 * 1024,
  });
  await new Promise<void>((r) => httpServer.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(httpServer.address() as net.AddressInfo).port}`;
});
after(async () => {
  await manager.closeAll("shutdown", 200);
  httpServer.closeAllConnections();
  await new Promise<void>((r) => httpServer.close(() => r()));
  await host.close();
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function api(
  method: string,
  url: string,
  json?: unknown,
  auth = token,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(base + url, {
    method,
    headers: {
      authorization: `Bearer ${auth}`,
      ...(json !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : {}) as Record<string, unknown> };
}

interface Client {
  ws: WebSocket;
  frames: Array<Record<string, unknown>>;
  bytes: string;
  closed: Promise<{ code: number; reason: string }>;
}

function connect(t: TestContext, terminalId: string, auth = token): Promise<Client> {
  const ws = new WebSocket(`${base.replace("http", "ws")}/v1/terminals/${terminalId}/stream`, {
    headers: { authorization: `Bearer ${auth}` },
  });
  const client: Client = {
    ws,
    frames: [],
    bytes: "",
    closed: new Promise((resolve) =>
      ws.once("close", (code, reason) => resolve({ code, reason: reason.toString() })),
    ),
  };
  ws.on("message", (data, isBinary) => {
    if (isBinary) client.bytes += (data as Buffer).toString("utf8");
    else client.frames.push(JSON.parse(data.toString()) as Record<string, unknown>);
  });
  t.after(() => ws.terminate());
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve(client));
    ws.once("unexpected-response", (_req, res) => reject(new Error(`upgrade refused: ${res.statusCode}`)));
    ws.once("error", reject);
  });
}

test("refusals a client degrades against: bad body, unknown workspace, the switch, the cap, no addon", {
  skip,
}, async () => {
  assert.equal((await api("POST", "/v1/workspaces/default/terminals", { cols: 0, rows: 24 })).status, 400);
  assert.equal((await api("POST", "/v1/workspaces/nope/terminals", { cols: 80, rows: 24 })).status, 404);
  assert.equal(
    (await api("POST", "/v1/workspaces/default/terminals", { cols: 80, rows: 24, argv: "sh -c" })).status,
    400,
    "argv is an array, never a string",
  );
  manager.enabled = false;
  const off = await api("POST", "/v1/workspaces/default/terminals", { cols: 80, rows: 24 });
  assert.equal(off.status, 403);
  assert.equal((off.body.error as { code: string }).code, "terminals_disabled");
  manager.enabled = true;
  manager.maxTerminals = 0;
  const cap = await api("POST", "/v1/workspaces/default/terminals", { cols: 80, rows: 24 });
  assert.equal(cap.status, 503);
  assert.equal((cap.body.error as { code: string }).code, "terminal_cap");
  manager.maxTerminals = 16;
  assert.equal((await api("GET", "/v1/terminals/tm_nope")).status, 404);
  assert.equal((await api("GET", "/v1/terminals", undefined, "pid_nope_nope")).status, 401);
});

test("open, attach with a snapshot first, type, fan out to a second client, resize, close with an exit frame", {
  skip,
}, async (t) => {
  const created = await api("POST", "/v1/workspaces/default/terminals", { cols: 80, rows: 24 });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const term = created.body.terminal as { id: string; status: string; pid: number; cols: number };
  assert.equal(term.status, "running");
  assert.ok(term.pid > 0);
  assert.equal(term.cols, 80);
  assert.ok(events.some((e) => e.type === "terminal.created" && e.scope === "workspace:default"));

  const a = await connect(t, term.id);
  const snapA = await waitFor(t, () => a.frames.find((f) => f.type === "snapshot"));
  assert.equal(snapA.cols, 80);
  assert.equal(snapA.rows, 24);
  assert.equal(typeof snapA.data, "string");
  assert.equal(a.frames[0]?.type, "snapshot", "the snapshot is the first frame");

  // wait for a prompt-ish sign of life, then type
  await waitFor(t, () => (a.bytes.length > 0 ? true : undefined));
  a.ws.send(Buffer.from("echo marker-xyz-123\r"));
  await waitFor(t, () => (a.bytes.includes("marker-xyz-123") ? true : undefined));

  const b = await connect(t, term.id);
  const snapB = await waitFor(t, () => b.frames.find((f) => f.type === "snapshot"));
  assert.ok(
    (snapB.data as string).includes("marker-xyz-123"),
    "the second client's snapshot shows what the first typed",
  );
  const info = await api("GET", `/v1/terminals/${term.id}`);
  assert.equal((info.body.terminal as { attachedCount: number }).attachedCount, 2);

  b.ws.send(JSON.stringify({ type: "resize", cols: 100, rows: 30 }));
  const resized = await waitFor(t, () => a.frames.find((f) => f.type === "resize"));
  assert.deepEqual(resized, { type: "resize", cols: 100, rows: 30 });
  assert.equal(((await api("GET", `/v1/terminals/${term.id}`)).body.terminal as { cols: number }).cols, 100);
  b.ws.send(JSON.stringify({ type: "ping" }));
  await waitFor(t, () => b.frames.find((f) => f.type === "pong"));
  b.ws.send("not json");
  const bClosed = await b.closed;
  assert.equal(bClosed.code, 1007);

  const list = await api("GET", "/v1/terminals?workspace=default");
  assert.equal((list.body.terminals as unknown[]).length, 1);

  const closed = await api("DELETE", `/v1/terminals/${term.id}?grace=300`);
  assert.equal(closed.status, 200, JSON.stringify(closed.body));
  const exit = (closed.body.terminal as { status: string; exit: { reason: string } }).exit;
  assert.equal(exit.reason, "closed");
  const exitFrame = await waitFor(t, () => a.frames.find((f) => f.type === "exit"));
  assert.equal((exitFrame.exit as { reason: string }).reason, "closed");
  const aClosed = await a.closed;
  assert.equal(aClosed.code, 1000);
  assert.equal((await api("GET", `/v1/terminals/${term.id}`)).status, 404, "closed terminals are forgotten");
  assert.ok(
    events.some(
      (e) => e.type === "terminal.exited" && (e.payload as { terminalId: string }).terminalId === term.id,
    ),
  );
});

test("a client that cannot keep up is disconnected with a reason and the terminal keeps running", {
  skip,
}, async (t) => {
  const created = await api("POST", "/v1/workspaces/default/terminals", {
    cols: 80,
    rows: 24,
    argv: node(
      "const chunk = 'y'.repeat(1023) + '\\n'; let n = 0; const tick = () => { for (let i = 0; i < 64; i++) process.stdout.write(chunk); setImmediate(tick) }; tick()",
    ),
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = (created.body.terminal as { id: string }).id;
  const slow = await connect(t, id);
  await waitFor(t, () => slow.frames.find((f) => f.type === "snapshot"));
  // stop reading: the server's per-connection buffer fills and it must cut us, not the PTY
  (slow.ws as unknown as { _socket: net.Socket })._socket.pause();
  await new Promise((r) => setTimeout(r, 3000));
  (slow.ws as unknown as { _socket: net.Socket })._socket.resume();
  const closed = await slow.closed;
  assert.equal(closed.code, 1008, `expected slow-consumer cut, got ${closed.code} ${closed.reason}`);
  assert.equal(closed.reason, "slow consumer");
  const info = await api("GET", `/v1/terminals/${id}`);
  assert.equal(info.status, 200);
  assert.equal((info.body.terminal as { attachedCount: number }).attachedCount, 0);
  const fresh = await connect(t, id);
  const snap = await waitFor(t, () => fresh.frames.find((f) => f.type === "snapshot"));
  assert.ok((snap.data as string).includes("yyyy"), "reattaching gets a fresh snapshot");
  await api("DELETE", `/v1/terminals/${id}?grace=200`);
});

test("a terminal that exits on its own reports it, and DELETE on it just forgets it", { skip }, async (t) => {
  const created = await api("POST", "/v1/workspaces/default/terminals", {
    cols: 80,
    rows: 24,
    argv: node("process.exit(3)"),
  });
  const id = (created.body.terminal as { id: string }).id;
  const exited = await waitFor(t, () => {
    const e = events.find(
      (x) => x.type === "terminal.exited" && (x.payload as { terminalId: string }).terminalId === id,
    );
    return e ? (e.payload as { code: number; reason: string }) : undefined;
  });
  assert.equal(exited.code, 3);
  assert.equal(exited.reason, "exited");
  const info = await api("GET", `/v1/terminals/${id}`);
  assert.equal((info.body.terminal as { status: string }).status, "exited");
  const late = await connect(t, id);
  await waitFor(t, () => late.frames.find((f) => f.type === "exit"));
  assert.equal((await late.closed).code, 1000);
  assert.equal((await api("DELETE", `/v1/terminals/${id}`)).status, 200);
  assert.equal((await api("GET", `/v1/terminals/${id}`)).status, 404);
  const list = await api("GET", "/v1/terminals");
  assert.equal(list.status, 200);
  assert.ok(!(list.body.terminals as Array<{ id: string }>).some((x) => x.id === id));
});

test("the stream refuses a bad token and an unknown terminal before upgrading", { skip }, async (t) => {
  await assert.rejects(connect(t, "tm_nope"), /upgrade refused: 404/);
  const created = await api("POST", "/v1/workspaces/default/terminals", {
    cols: 80,
    rows: 24,
    argv: node("setTimeout(() => {}, 5000)"),
  });
  const id = (created.body.terminal as { id: string }).id;
  await assert.rejects(connect(t, id, "pid_bad_token"), /upgrade refused: 401/);
  await api("DELETE", `/v1/terminals/${id}?grace=100`);
});
