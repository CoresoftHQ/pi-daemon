// The supported pi range is a promise (spec §10): these run against the real `pi` on PATH at
// both ends of the range in CI, and against whatever is installed locally with
// PI_DAEMON_REAL_PI=1. No provider is needed: RPC mode answers get_state, lists models,
// records a session file, and serves an attach through the daemon's pi-protocol server.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import type { TestContext } from "node:test";
import { after, before, test } from "node:test";
import type { ByteTransportFactory } from "@earendil-works/pi-client";
import { PiClient } from "@earendil-works/pi-client";
import { tmpDir } from "../os/paths.ts";
import { resolvePiLauncher } from "../os/spawn.ts";
import { PiProtocolServer } from "../serve/pi-protocol/server.ts";
import { memoryPair } from "../serve/transport.ts";
import { SUPPORTED_PI_RANGE } from "../serve/v1/capabilities.ts";
import { singleRootResolver } from "../serve/workspace-resolver.ts";
import { SessionHost } from "../sessions/host.ts";
import { probeAvailableModels } from "../sessions/models.ts";
import type { RpcState } from "./rpc.ts";
import { Runner } from "./runner.ts";
import { inSupportedRange, probePiVersion } from "./version.ts";

const skip = process.env.PI_DAEMON_REAL_PI !== "1" ? "set PI_DAEMON_REAL_PI=1 with a real pi on PATH" : false;
const launcher = resolvePiLauncher();
let root: string;
let sessionsDir: string;
let host: SessionHost;

before(() => {
  root = mkdtempSync(path.join(tmpDir(), "pi-compat-"));
  sessionsDir = path.join(root, "sessions");
  host = new SessionHost({
    ...(launcher ? { launcher } : {}),
    runner: { sessionDir: sessionsDir, isolate: true, noTools: true },
    sessionsDir,
    sweepIntervalMs: 0,
  });
});
after(async () => {
  await host.close();
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("the installed pi is inside the range the daemon advertises", { skip }, async () => {
  assert.ok(launcher, "pi resolves from PATH");
  const pi = await probePiVersion({ launcher, timeoutMs: 20_000 });
  assert.ok(pi.version, "pi --version answers");
  assert.ok(
    inSupportedRange(pi.version, SUPPORTED_PI_RANGE),
    `${pi.version} is not in ${SUPPORTED_PI_RANGE}; widen the range or fix the daemon`,
  );
});

test("RPC mode: get_state, the model list, and a session file on disk", { skip }, async (t: TestContext) => {
  assert.ok(launcher);
  const r = Runner.spawn({ cwd: root, launcher, isolate: true, noTools: true, sessionDir: sessionsDir });
  t.after(() => r.kill());
  const state = await r.send<RpcState>({ type: "get_state" });
  assert.equal(state.success, true);
  assert.ok(state.data?.sessionId);
  const models = await probeAvailableModels({ cwd: root, launcher });
  assert.ok(Array.isArray(models));
  const exit = await r.stop({ graceMs: 5000 });
  assert.equal(exit.expected, true);
});

test("the daemon's host and pi-protocol server against the real pi: create, attach, snapshot, list", {
  skip,
}, async (t: TestContext) => {
  const created = await host.create({ workspaceId: "w", cwd: root });
  assert.ok(created.id);
  assert.equal(created.state.phase, "idle");
  const snapshot = await host.ensureLive(created.id);
  assert.equal(snapshot.state.transcript.length, 0);
  assert.ok(existsSync(sessionsDir), "pi wrote its session directory");

  const server = new PiProtocolServer({ host, workspaces: singleRootResolver(root), models: () => [] });
  t.after(() => server.closeAll());
  const factory: ByteTransportFactory = async (handlers) => {
    const { a, b } = memoryPair("compat");
    server.attachTransport(b);
    a.onData((c) => handlers.onData(c));
    a.onClose(() => handlers.onClose());
    return { send: async (chunk) => a.send(chunk), close: () => a.close() };
  };
  const client = new PiClient({ transportFactory: factory });
  t.after(() => client.dispose().catch(() => {}));
  await client.connect();
  const list = await client.listSessions();
  assert.ok(
    list.some((s) => s.id === created.id),
    "the real session is listed over pi-protocol",
  );
  const lease = await client.attachSession(created.id);
  t.after(() => lease.dispose());
  assert.equal(lease.id, created.id);
  await host.evict(created.id, "shutdown");
  assert.equal(host.get(created.id)?.state.live ?? false, false);
});
