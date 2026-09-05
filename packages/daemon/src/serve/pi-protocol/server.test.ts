// Conformance: pi's own PiClient drives our server. Most cases run over an in-memory transport
// pair (no ports); the WebSocket and local-endpoint cases exercise the real transports.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import type { TestContext } from "node:test";
import { after, before, test } from "node:test";
import type { ByteTransportFactory } from "@earendil-works/pi-client";
import { PiClient, PiServerError } from "@earendil-works/pi-client";
import { createUnixTransportFactory } from "@earendil-works/pi-client/unix";
import type { ServerEvent, ServerMessage, SessionSnapshot } from "@earendil-works/pi-protocol";
import { createServerMessageDecoder, encodeClientMessage, encodeFrame } from "@earendil-works/pi-protocol";
import WebSocket from "ws";
import { localEndpointPath } from "../../os/ipc.ts";
import { platform, tmpDir } from "../../os/paths.ts";
import { SessionHost } from "../../sessions/host.ts";
import type { AvailableModel as RpcModel } from "../../sessions/models.ts";
import { probeAvailableModels } from "../../sessions/models.ts";
import type { ByteDuplex } from "../transport.ts";
import { memoryPair } from "../transport.ts";
import { singleRootResolver } from "../workspace-resolver.ts";
import { PiProtocolServer } from "./server.ts";
import { attachWebSocketListener, listenLocalEndpoint, staticTokenAuthenticator } from "./ws.ts";

const FAKE = path.resolve(import.meta.dirname, "..", "..", "..", "test", "fake-pi.mjs");
const launcher = { command: process.execPath, prefix: [FAKE], source: "env" as const };
const env = { PATH: process.env.PATH ?? "" };
let root: string;
let host: SessionHost;
let models: RpcModel[];
let server: PiProtocolServer;

before(async () => {
  root = mkdtempSync(path.join(tmpDir(), "pi-daemon-proto-"));
  host = new SessionHost({ launcher, env, sweepIntervalMs: 0 });
  models = await probeAvailableModels({ cwd: root, env, launcher });
  server = new PiProtocolServer({
    host,
    workspaces: singleRootResolver(root),
    models: () => models,
    maxFrameLength: 1 << 20,
    disabledCommands: new Set(["set_thinking"]),
  });
});
after(async () => {
  server.closeAll();
  await host.close();
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/** A ByteTransportFactory over the client end of an in-memory pair whose server end is attached. */
function memoryFactory(): ByteTransportFactory {
  return async (handlers) => {
    const { a, b } = memoryPair();
    server.attachTransport(b);
    a.onData((c) => handlers.onData(c));
    a.onClose(() => handlers.onClose());
    return { send: async (chunk) => a.send(chunk), close: () => a.close() };
  };
}

async function client(t: TestContext): Promise<PiClient> {
  const c = new PiClient({ transportFactory: memoryFactory(), maxFrameLength: 1 << 20 });
  t.after(() => c.dispose().catch(() => {}));
  await c.connect();
  return c;
}

/** A raw connection for the cases pi-client refuses to produce (bad hello, unattached mutations, oversized frames). */
function rawConnection(): {
  a: ByteDuplex;
  messages: ServerMessage[];
  closed: Promise<void>;
  send(bytes: Uint8Array): void;
} {
  const { a, b } = memoryPair();
  server.attachTransport(b);
  const decoder = createServerMessageDecoder({ maxFrameLength: 1 << 20 });
  const messages: ServerMessage[] = [];
  const closed = new Promise<void>((r) => a.onClose(() => r()));
  a.onData((c) => {
    for (const m of decoder.push(c)) messages.push(m);
  });
  return { a, messages, closed, send: (bytes) => a.send(bytes) };
}

const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));

interface Observable {
  subscribe(l: (s: SessionSnapshot) => void): () => void;
  readonly snapshot: SessionSnapshot | undefined;
}

/**
 * Wait until the authoritative snapshot satisfies a predicate. Frames can batch on a real
 * transport, so intermediate phases may never be observed; only wait on end states.
 */
function waitFor(
  lease: Observable,
  pred: (s: SessionSnapshot) => boolean,
  timeoutMs = 10_000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (lease.snapshot && pred(lease.snapshot)) return resolve();
    const timer = setTimeout(() => {
      unsub();
      reject(new Error("timed out waiting for snapshot condition"));
    }, timeoutMs);
    const unsub = lease.subscribe((s) => {
      if (pred(s)) {
        clearTimeout(timer);
        unsub();
        resolve();
      }
    });
  });
}
const finished = (n: number) => (s: SessionSnapshot) => s.phase === "idle" && s.transcript.length >= n;

test("hello: protocol version 1, a serverId, and the configured models", async (t) => {
  const c = await client(t);
  const snap = c.snapshot;
  assert.equal(snap?.protocolVersion, 1);
  assert.equal(snap?.serverId, server.serverId);
  assert.equal(snap?.models.length, 1);
  assert.equal(snap?.models[0]?.provider, "fake");
});

test("a wrong protocol version gets hello_error(version) and the connection closes", async () => {
  const raw = rawConnection();
  raw.send(encodeClientMessage({ type: "hello", version: 99 }));
  await raw.closed;
  assert.deepEqual(
    raw.messages.map((m) => m.type),
    ["hello_error"],
  );
  const m = raw.messages[0];
  assert.ok(m?.type === "hello_error" && m.error.code === "version");
});

test("a request before hello is refused", async () => {
  const raw = rawConnection();
  raw.send(encodeClientMessage({ type: "request", id: "1", request: { command: "list" } }));
  await raw.closed;
  assert.ok(raw.messages[0]?.type === "hello_error");
});

test("create, prompt, stream, settle — snapshots authoritative, progress transient", async (t) => {
  const c = await client(t);
  const events: ServerEvent[] = [];
  c.onEvent((e) => events.push(e));
  const lease = await c.createSession({ cwd: "." });
  t.after(() => lease.dispose().catch(() => {}));
  assert.equal(lease.snapshot?.phase, "idle");
  assert.equal(lease.snapshot?.attached, true);
  const expectedCwd = singleRootResolver(root).resolveCwd();
  assert.ok(expectedCwd.ok);
  if (expectedCwd.ok) assert.equal(lease.snapshot?.cwd, expectedCwd.cwd);

  const done = waitFor(lease, finished(2));
  const before = lease.snapshot?.revision ?? 0;
  const snap = await lease.prompt("hello there");
  assert.ok(snap.revision > before, "prompt response carries a newer revision");
  await done;
  await settle();
  const transcript = lease.snapshot?.transcript ?? [];
  assert.equal(transcript[0]?.role, "user");
  assert.equal(transcript[1]?.role, "assistant");
  const progress = events.filter((e) => e.type === "session_progress");
  assert.ok(progress.some((e) => e.type === "session_progress" && e.progress.type === "assistant_delta"));
  assert.ok(progress.some((e) => e.type === "session_progress" && e.progress.type === "item_finished"));
  assert.ok(events.some((e) => e.type === "session_snapshot"));
  assert.ok(
    events.some((e) => e.type === "server_snapshot"),
    "session list change broadcast",
  );
});

test("a cwd outside every workspace is invalid_request with the rule named", async (t) => {
  const c = await client(t);
  await assert.rejects(
    c.createSession({ cwd: "../../../outside" }),
    (e: unknown) =>
      e instanceof PiServerError &&
      e.code === "invalid_request" &&
      (e.details as { rule?: string })?.rule === "workspace",
  );
});

test("attach from a second connection shares the session; both see the next turn", async (t) => {
  const c1 = await client(t);
  const c2 = await client(t);
  const l1 = await c1.createSession({ cwd: "." });
  t.after(() => l1.dispose().catch(() => {}));
  const l2 = await c2.attachSession(l1.id);
  t.after(() => l2.dispose().catch(() => {}));
  assert.equal(l2.snapshot?.id, l1.id);
  assert.equal(l2.snapshot?.attached, true);
  assert.equal(l2.snapshot?.locked, false);

  const done1 = waitFor(l1, finished(2));
  const done2 = waitFor(l2, finished(2));
  await l2.prompt("from the second client");
  await done1;
  await done2;
});

test("prompt during a turn is busy; pi-protocol has no queue mode", async (t) => {
  const c = await client(t);
  const l = await c.createSession({ cwd: "." });
  t.after(() => l.dispose().catch(() => {}));
  const done = waitFor(l, finished(2));
  await l.prompt("SLOW one two three four five six");
  await assert.rejects(l.prompt("again"), (e: unknown) => e instanceof PiServerError && e.code === "busy");
  await l.abort();
  await done;
});

test("attach to an unknown session is not_found", async (t) => {
  const c = await client(t);
  await assert.rejects(
    c.attachSession("nope"),
    (e: unknown) => e instanceof PiServerError && e.code === "not_found",
  );
});

test("a mutation from a connection that never attached is invalid_request", async (t) => {
  const c = await client(t);
  const l = await c.createSession({ cwd: "." });
  t.after(() => l.dispose().catch(() => {}));
  const raw = rawConnection();
  raw.send(encodeClientMessage({ type: "hello", version: 1 }));
  raw.send(
    encodeClientMessage({
      type: "request",
      id: "r1",
      request: { command: "prompt", sessionId: l.id, text: "sneaky" },
    }),
  );
  await settle(100);
  const resp = raw.messages.find((m) => m.type === "response");
  assert.ok(resp?.type === "response" && resp.ok === false && resp.error.code === "invalid_request");
  raw.a.close();
});

test("detach stops the fan-out", async (t) => {
  const c = await client(t);
  const l = await c.createSession({ cwd: "." });
  const id = l.id;
  await l.detach();
  const events: ServerEvent[] = [];
  c.onEvent((e) => events.push(e));
  // Drive a turn through another client; the detached one must not receive session events.
  const c2 = await client(t);
  const l2 = await c2.attachSession(id);
  t.after(() => l2.dispose().catch(() => {}));
  const done = waitFor(l2, finished(2));
  await l2.prompt("after detach");
  await done;
  await settle();
  assert.ok(!events.some((e) => e.type === "session_progress"), "no progress after detach");
});

test("a disabled command answers not_implemented", async (t) => {
  const c = await client(t);
  const l = await c.createSession({ cwd: "." });
  t.after(() => l.dispose().catch(() => {}));
  await assert.rejects(
    l.setThinking("high"),
    (e: unknown) => e instanceof PiServerError && e.code === "not_implemented",
  );
});

test("set_model round-trips through the runner", async (t) => {
  const c = await client(t);
  const l = await c.createSession({ cwd: "." });
  t.after(() => l.dispose().catch(() => {}));
  const snap = await l.setModel({ provider: "fake", id: "fake-1" });
  assert.deepEqual(snap.model, { provider: "fake", id: "fake-1" });
});

test("an oversized frame closes the connection", async () => {
  const raw = rawConnection();
  raw.send(encodeClientMessage({ type: "hello", version: 1 }));
  await settle();
  raw.send(encodeFrame(new Uint8Array(2 * (1 << 20))));
  await raw.closed;
});

test("reconnect: attach again and the revision has not gone backwards", async (t) => {
  const c = await client(t);
  const l = await c.createSession({ cwd: "." });
  const id = l.id;
  const done = waitFor(l, finished(2));
  await l.prompt("before reconnect");
  await done;
  const rev = l.snapshot?.revision ?? 0;
  c.disconnect("test");
  await c.reconnect();
  const again = await c.attachSession(id);
  t.after(() => again.dispose().catch(() => {}));
  assert.ok((again.snapshot?.revision ?? 0) >= rev);
  assert.equal(again.snapshot?.transcript.length, 2);
});

test("WebSocket transport: subprotocol and bearer token at the upgrade", async (t) => {
  const httpServer = http.createServer((_req, res) => {
    res.statusCode = 404;
    res.end();
  });
  attachWebSocketListener(httpServer, { server, authenticate: staticTokenAuthenticator("s3cret") });
  await new Promise<void>((r) => httpServer.listen(0, "127.0.0.1", r));
  let good: PiClient | undefined;
  t.after(async () => {
    await good?.dispose().catch(() => {});
    server.closeAll("test teardown");
    httpServer.closeAllConnections();
    await new Promise<void>((r) => httpServer.close(() => r()));
  });
  const port = (httpServer.address() as net.AddressInfo).port;
  const url = `ws://127.0.0.1:${port}/pi/v1/socket`;

  const factory =
    (headers: Record<string, string>, protocols: string[] = ["pi.v1"]): ByteTransportFactory =>
    async (handlers) => {
      const ws = new WebSocket(url, protocols, { headers });
      await new Promise<void>((res, rej) => {
        ws.once("open", res);
        ws.once("unexpected-response", (req, resp) => {
          req.destroy();
          rej(new Error(`upgrade refused: ${resp.statusCode}`));
        });
        ws.once("error", rej);
      });
      ws.on("message", (d) => handlers.onData(new Uint8Array(d as Buffer)));
      ws.on("close", () => handlers.onClose());
      return { send: async (c) => ws.send(c, { binary: true }), close: () => ws.close() };
    };

  good = new PiClient({ transportFactory: factory({ Authorization: "Bearer s3cret" }) });
  const snap = await good.connect();
  assert.equal(snap.serverId, server.serverId);
  const l = await good.createSession({ cwd: "." });
  const done = waitFor(l, finished(2));
  await l.prompt("over websocket");
  await done;
  await l.dispose();

  const bad = new PiClient({ transportFactory: factory({ Authorization: "Bearer wrong" }) });
  await assert.rejects(bad.connect(), /401/);
  const noProto = new PiClient({ transportFactory: factory({ Authorization: "Bearer s3cret" }, []) });
  await assert.rejects(noProto.connect());
});

/**
 * A net.connect(path) transport, which is all the local endpoint needs. pi-client ships one for
 * Unix sockets but refuses to run it on Windows, so a Windows client brings these twelve lines.
 */
function localFactory(endpoint: string): ByteTransportFactory {
  return async (handlers) => {
    const sock = net.connect(endpoint);
    await new Promise<void>((res, rej) => {
      sock.once("connect", res);
      sock.once("error", rej);
    });
    sock.on("data", (d: Buffer) => handlers.onData(new Uint8Array(d)));
    sock.on("close", () => handlers.onClose());
    sock.on("error", (e) => handlers.onError(e));
    return { send: async (c) => void sock.write(c), close: () => sock.destroy() };
  };
}

test("local endpoint: reachable through net.connect(path); pi-client's Unix helper where it runs", async (t) => {
  const endpoint = localEndpointPath(root, `pi-daemon-test-${process.pid}`);
  const netServer = net.createServer();
  await listenLocalEndpoint(server, endpoint, netServer);
  let c: PiClient | undefined;
  t.after(async () => {
    await c?.dispose().catch(() => {});
    server.closeAll("test teardown");
    await new Promise<void>((r) => netServer.close(() => r()));
  });

  const factory =
    platform === "win32" ? localFactory(endpoint) : createUnixTransportFactory({ path: endpoint });
  c = new PiClient({ transportFactory: factory });
  const snap = await c.connect();
  assert.equal(snap.serverId, server.serverId);
  const l = await c.createSession({ cwd: "." });
  const done = waitFor(l, finished(2));
  await l.prompt("over the local endpoint");
  await done;
  await l.dispose();
});

test("a slow consumer is disconnected rather than stalling the producer", async (t) => {
  const tight = new PiProtocolServer({
    host,
    workspaces: singleRootResolver(root),
    models: () => models,
    maxBufferedBytes: 1,
  });
  t.after(() => tight.closeAll());
  const { a, b } = memoryPair();
  let closedReason: string | undefined;
  a.onClose((r) => {
    closedReason = r;
  });
  // A duplex that never drains: bufferedAmount reports everything ever sent.
  let buffered = 0;
  const stuck: ByteDuplex = {
    label: "stuck",
    get bufferedAmount() {
      return buffered;
    },
    onData: (h) => b.onData(h),
    onClose: (h) => b.onClose(h),
    send: (c) => {
      buffered += c.length;
      b.send(c);
    },
    close: (r) => b.close(r),
  };
  tight.attachTransport(stuck);
  a.send(encodeClientMessage({ type: "hello", version: 1 }));
  await settle(50);
  assert.equal(closedReason, "slow consumer");
});
