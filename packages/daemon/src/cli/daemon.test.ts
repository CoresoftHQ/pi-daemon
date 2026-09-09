// The composition root and the CLI against it: start on loopback with a fake pi, serve
// health and capabilities computed from real state, refuse a second instance by pid and
// port, pair over the control endpoint (with and without --confirm), and stop cleanly with
// `daemon.shutdown` emitted and the lock released.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import type { TestContext } from "node:test";
import { test } from "node:test";
import { LockHeldError } from "../os/lock.ts";
import { createLogger } from "../os/log.ts";
import type { AppDirs } from "../os/paths.ts";
import { appDirs, tmpDir } from "../os/paths.ts";
import type { DaemonConfig } from "./config.ts";
import { DEFAULT_CONFIG } from "./config.ts";
import { controlRequest } from "./control.ts";
import type { RunningDaemon } from "./daemon.ts";
import { startDaemon } from "./daemon.ts";
import type { CliIo } from "./main.ts";
import { runCli } from "./main.ts";

const FAKE = path.resolve(import.meta.dirname, "..", "..", "test", "fake-pi.mjs");
const launcher = { command: process.execPath, prefix: [FAKE], source: "env" as const };
const quiet = createLogger({ level: "error", stderr: false });

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

function home(t: TestContext): { dirs: AppDirs; root: string } {
  const root = mkdtempSync(path.join(tmpDir(), "pid-daemon-"));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return { dirs: appDirs("pi-daemon", { PI_DAEMON_HOME: root }), root };
}

async function start(t: TestContext, dirs: AppDirs, config: DaemonConfig): Promise<RunningDaemon> {
  const d = await startDaemon({
    dirs,
    config,
    version: "0.0.0-test",
    launcher,
    env: { PATH: process.env.PATH ?? "" },
    logger: quiet,
  });
  t.after(() => d.stop("test"));
  return d;
}

const get = async (url: string, token?: string) => {
  const res = await fetch(url, token ? { headers: { authorization: `Bearer ${token}` } } : undefined);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};

test("start, serve, refuse a second instance, pair, stop", async (t) => {
  const { dirs } = home(t);
  const port = await freePort();
  const config = { ...DEFAULT_CONFIG, port };
  const d = await start(t, dirs, config);
  assert.equal(d.address, "127.0.0.1");
  assert.equal(d.tls, null, "loopback is plaintext by default");
  assert.ok(existsSync(path.join(dirs.state, "pi-daemon.lock")));
  const base = `http://127.0.0.1:${port}`;
  assert.equal((await get(`${base}/v1/health`)).status, 200);
  assert.equal((await get(`${base}/v1/capabilities`)).status, 401);

  await assert.rejects(
    startDaemon({ dirs, config, version: "0.0.0-test", launcher, logger: quiet }),
    (e: unknown) => e instanceof LockHeldError && e.holder.pid === process.pid && e.holder.port === port,
    "a second serve names the running pid and port",
  );

  const ping = (await controlRequest(dirs.state, "ping")) as { pid: number; port: number };
  assert.deepEqual(ping, { pid: process.pid, port });
  const status = (await controlRequest(dirs.state, "status")) as Record<string, unknown>;
  assert.equal(status.daemonId, d.identity.id);
  assert.equal(status.tls, "off");
  const caps = status.capabilities as {
    features: string[];
    absent: string[];
    limits: Record<string, number>;
  };
  assert.ok(caps.features.includes("files.write"));
  assert.ok(caps.features.includes("worktrees"), "git is on this machine");
  assert.ok(caps.features.includes("terminals") || caps.absent.includes("terminals"));
  assert.equal(caps.limits.maxTerminals, 16);

  // pairing over the control endpoint, redeemed over HTTP
  const issued = (await controlRequest(dirs.state, "pair.issue")) as {
    code: string;
    payload: Record<string, unknown>;
  };
  assert.match(issued.code, /^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
  assert.equal(issued.payload.host, "127.0.0.1");
  assert.equal(issued.payload.port, port);
  assert.equal(issued.payload.fp, undefined, "no TLS, no fingerprint");
  const redeem = await fetch(`${base}/v1/pair/redeem`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: issued.code, deviceName: "phone", platform: "ios" }),
  });
  assert.equal(redeem.status, 200);
  const token = ((await redeem.json()) as { token: string }).token;
  const capsHttp = await get(`${base}/v1/capabilities`, token);
  assert.equal(capsHttp.status, 200);
  assert.equal((capsHttp.body.daemon as { id: string }).id, d.identity.id);
  const list = (await controlRequest(dirs.state, "devices.list")) as Array<{ role: string; name: string }>;
  assert.equal(list.length, 1);
  assert.equal(list[0]?.role, "owner");
  assert.ok(d.host.log.replay(0).events.some((e) => e.type === "device.paired"));

  // --confirm: the daemon asks this side y/N at redemption
  const asked: unknown[] = [];
  const confirmed = controlRequest(
    dirs.state,
    "pair.issue",
    { confirm: true },
    {
      timeoutMs: 20_000,
      onEvent: (event, data) => {
        asked.push({ event, data });
        return event === "confirm";
      },
    },
  ) as Promise<{ code: string; redeemed: unknown }>;
  await new Promise((r) => setTimeout(r, 100));
  const active = (await controlRequest(dirs.state, "pair.active")) as { code: string };
  const r2 = await fetch(`${base}/v1/pair/redeem`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: active.code, deviceName: "laptop", platform: "macos" }),
  });
  assert.equal(r2.status, 200);
  const result = await confirmed;
  assert.ok(result.redeemed, "the CLI side learns who paired");
  assert.deepEqual(asked[0], { event: "confirm", data: { deviceName: "laptop", platform: "macos" } });
  assert.equal(((await controlRequest(dirs.state, "devices.list")) as unknown[]).length, 2);

  // a service token, and revocation
  const svc = (await controlRequest(dirs.state, "devices.create", { name: "n8n", role: "member" })) as {
    device: { id: string; role: string };
    token: string;
  };
  assert.equal(svc.device.role, "member");
  assert.equal((await get(`${base}/v1/capabilities`, svc.token)).status, 200);
  assert.deepEqual(await controlRequest(dirs.state, "devices.revoke", { id: svc.device.id }), {
    revoked: true,
  });
  assert.equal((await get(`${base}/v1/capabilities`, svc.token)).status, 401);

  // stop through the control endpoint: shutdown event, lock released, nothing answers
  await controlRequest(dirs.state, "stop");
  assert.equal(await d.stopped, "control");
  assert.ok(d.host.log.replay(0).events.some((e) => e.type === "daemon.shutdown"));
  assert.ok(!existsSync(path.join(dirs.state, "pi-daemon.lock")), "the lock is released");
  await assert.rejects(fetch(`${base}/v1/health`));
  await assert.rejects(controlRequest(dirs.state, "ping", {}, { timeoutMs: 1000 }));
});

test("the CLI end to end: serve in-process, status, pair, config, stop", async (t) => {
  const { dirs, root } = home(t);
  const port = await freePort();
  const out: string[] = [];
  const err: string[] = [];
  const take = () => out.splice(0).join("");
  const takeErr = () => err.splice(0).join("");
  const io: CliIo = {
    stdout: (s) => out.push(s),
    stderr: (s) => err.push(s),
    env: { PATH: process.env.PATH ?? "", PI_DAEMON_HOME: root, PI_DAEMON_PI: FAKE },
    entry: "/opt/pi-daemon/dist/cli/main.js",
  };
  assert.equal(await runCli(["--version"], io), 0);
  assert.match(take(), /^\d+\.\d+\.\d+/);
  assert.equal(await runCli([], io), 2, "no command prints usage and fails");
  take();
  assert.equal(await runCli(["config", "set", "port", String(port)], io), 0);
  take();
  assert.equal(await runCli(["config", "set", "port", "abc"], io), 2, "refused, not written");
  take();
  takeErr();
  assert.equal(await runCli(["config", "get", "port"], io), 0);
  assert.equal(take().trim(), String(port));
  assert.equal(await runCli(["status"], io), 3);
  assert.match(take(), /not running/);
  assert.equal(await runCli(["stop"], io), 0);
  assert.match(take(), /not running/);
  assert.equal(await runCli(["install", "--dry-run"], io), 0);
  const rendered = take();
  assert.ok(rendered.includes("serve") && rendered.includes("main.js"), rendered);

  const serving = runCli(["serve"], io);
  const deadline = Date.now() + 15_000;
  for (;;) {
    if (
      await controlRequest(dirs.state, "ping", {}, { timeoutMs: 500 }).then(
        () => true,
        () => false,
      )
    )
      break;
    if (Date.now() > deadline) assert.fail(`serve never answered: ${err.join("")}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(await runCli(["status"], io), 0);
  assert.match(take(), new RegExp(`listening {3}127\\.0\\.0\\.1:${port}`));
  assert.equal(await runCli(["serve"], io), 3, "a second serve refuses");
  assert.match(takeErr(), new RegExp(`already running: pid ${process.pid}, port ${port}`));
  assert.equal(await runCli(["pair"], io), 0);
  const pairOut = take();
  assert.match(pairOut, /"v":1,"host":"127\.0\.0\.1"/);
  assert.match(pairOut, /code [0-9A-Z]{4}-[0-9A-Z]{4}/);
  assert.ok(pairOut.includes("█"), "a QR was rendered");
  assert.equal(await runCli(["pair", "--list"], io), 0);
  assert.match(take(), /no devices paired/);
  assert.equal(await runCli(["logs", "-n", "3"], io), 0);
  assert.match(take(), /listening/);
  assert.equal(await runCli(["stop"], io), 0);
  assert.equal(await serving, 0);
  assert.match(takeErr(), /stopped \(control\)/);
});

test("CORS: off by default; listed origins get headers and preflight answers without a token", async (t) => {
  const { dirs } = home(t);
  const port = await freePort();
  const d = await start(t, dirs, { ...DEFAULT_CONFIG, port, cors: { origins: ["https://app.example"] } });
  const base = `http://127.0.0.1:${port}`;
  const preflight = await fetch(`${base}/v1/sessions`, {
    method: "OPTIONS",
    headers: {
      origin: "https://app.example",
      "access-control-request-method": "POST",
      "access-control-request-headers": "authorization, content-type",
    },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), "https://app.example");
  assert.match(preflight.headers.get("access-control-allow-headers") ?? "", /authorization/);
  assert.equal(preflight.headers.get("vary"), "Origin");

  const plain = await fetch(`${base}/v1/health`, { headers: { origin: "https://app.example" } });
  assert.equal(plain.headers.get("access-control-allow-origin"), "https://app.example");
  assert.match(plain.headers.get("access-control-expose-headers") ?? "", /ETag/);

  const other = await fetch(`${base}/v1/health`, { headers: { origin: "https://evil.example" } });
  assert.equal(other.headers.get("access-control-allow-origin"), null, "an unlisted origin gets nothing");
  const otherPreflight = await fetch(`${base}/v1/sessions`, {
    method: "OPTIONS",
    headers: { origin: "https://evil.example", "access-control-request-method": "POST" },
  });
  assert.notEqual(otherPreflight.status, 204);
  await d.stop("test");
});
