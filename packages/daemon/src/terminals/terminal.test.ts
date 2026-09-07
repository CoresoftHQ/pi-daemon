// The terminal module against a real PTY: the addon loads from its prebuild, the environment
// is scrubbed, the screen keeps output and titles, resize coalesces, and close tree-kills a
// stuck child on every platform. Skipped where no PTY package loads, but that is a failure in
// CI, whose images must have the prebuilds.

import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { test } from "node:test";
import { pidAlive } from "../os/spawn.ts";
import type { Publish } from "./manager.ts";
import {
  TerminalCapError,
  TerminalManager,
  TerminalsDisabledError,
  TerminalsUnavailableError,
} from "./manager.ts";
import { loadPty, resetPtyCache } from "./pty.ts";

const status = loadPty().status;
if (!status.available && process.env.CI) throw new Error(`CI must have a PTY prebuild: ${status.error}`);
const skip = status.available ? false : (status.error ?? "no PTY");

async function waitFor<T>(t: TestContext, pred: () => T | undefined, ms = 15_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = pred();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error(`timed out after ${ms}ms in ${t.name}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

const node = (script: string) => [process.execPath, "-e", script];

function managerFor(t: TestContext, extra: Partial<ConstructorParameters<typeof TerminalManager>[0]> = {}) {
  const events: Array<{ scope: string; type: string; payload: unknown }> = [];
  const publish: Publish = (scope, type, payload) => events.push({ scope, type, payload });
  const manager = new TerminalManager({ publish, ...extra });
  t.after(() => manager.closeAll("shutdown", 200));
  return { manager, events };
}

test("the addon reports which package and backend loaded", { skip }, () => {
  assert.ok(status.package);
  assert.ok(["conpty", "winpty", "forkpty"].includes(status.backend ?? ""));
  assert.equal(status.error, null);
});

test("the shell never sees daemon state: PI_DAEMON_* is scrubbed, PATH survives", { skip }, async (t) => {
  const { manager } = managerFor(t, {
    env: { ...process.env, PI_DAEMON_TOKEN: "pid_secret_value", PI_DAEMON_PI: "/x/pi" },
  });
  let out = "";
  const term = await manager.create({
    workspaceId: "ws",
    cwd: process.cwd(),
    cols: 80,
    rows: 24,
    argv: node(
      "console.log('ENV=' + JSON.stringify(Object.keys(process.env).filter((k) => /^PI_DAEMON|^TERM$|^COLORTERM$|^PATH$/i.test(k)).sort()))",
    ),
  });
  term.attach((b) => {
    out += b.toString();
  });
  const exit = await term.exited();
  assert.equal(exit.code, 0);
  assert.equal(exit.reason, "exited");
  const m = /ENV=(\[.*?\])/.exec(out);
  assert.ok(m, out);
  const keys = JSON.parse(m[1] ?? "[]") as string[];
  assert.ok(!keys.some((k) => /^PI_DAEMON_TOKEN$/i.test(k)), `token leaked: ${keys}`);
  assert.ok(keys.includes("PI_DAEMON_PI"), "the pi pointer is kept");
  assert.ok(keys.includes("TERM") && keys.includes("COLORTERM"));
  assert.ok(!out.includes("pid_secret_value"));
});

test("the screen keeps output and the title; the snapshot replays both", { skip }, async (t) => {
  const { manager, events } = managerFor(t);
  const term = await manager.create({
    workspaceId: "ws",
    cwd: process.cwd(),
    cols: 40,
    rows: 10,
    argv: node(
      "process.stdout.write('\\x1b]0;my-title\\x07'); for (let i = 1; i <= 30; i++) console.log('line ' + i); setInterval(() => {}, 1000)",
    ),
  });
  assert.equal(term.status, "running");
  assert.ok(events.some((e) => e.type === "terminal.created" && e.scope === "workspace:ws"));
  await waitFor(t, () => (term.title === "my-title" ? true : undefined));
  const data = await term.snapshot();
  assert.ok(data.includes("line 30"), "the screen has the last line");
  assert.ok(data.includes("line 1"), "and the scrollback has the first");
  assert.ok(
    events.some((e) => e.type === "terminal.title" && (e.payload as { title: string }).title === "my-title"),
  );

  term.resize(20, 5);
  term.resize(30, 8);
  term.resize(60, 12);
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(term.cols, 60, "last resize wins");
  assert.equal(term.rows, 12);
  const info = term.info();
  assert.equal(info.title, "my-title");
  assert.equal(info.cols, 60);
  const exit = await manager.close(term.id, 200);
  assert.equal(exit.reason, "closed");
  assert.equal(manager.get(term.id), undefined);
  assert.ok(
    events.some((e) => e.type === "terminal.exited" && (e.payload as { reason: string }).reason === "closed"),
  );
});

test("close tree-kills a stuck child even after the shell itself has gone", { skip }, async (t) => {
  const { manager } = managerFor(t);
  let out = "";
  const term = await manager.create({
    workspaceId: "ws",
    cwd: process.cwd(),
    cols: 80,
    rows: 24,
    argv: node(
      "const { spawn } = require('node:child_process'); const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); console.log('CHILD=' + c.pid); setInterval(() => {}, 1000)",
    ),
  });
  term.attach((b) => {
    out += b.toString();
  });
  const child = Number(await waitFor(t, () => /CHILD=(\d+)/.exec(out)?.[1]));
  assert.ok(child > 0 && pidAlive(child));
  await manager.close(term.id, 300);
  await waitFor(t, () => (pidAlive(child) ? undefined : true), 5000).catch(() => {
    assert.fail(`orphaned child ${child} survived close`);
  });
});

test("the switch, the cap, and a machine without the addon", { skip }, async (t) => {
  const { manager } = managerFor(t, { maxTerminals: 1 });
  const a = await manager.create({
    workspaceId: "ws",
    cwd: process.cwd(),
    cols: 80,
    rows: 24,
    argv: node("setInterval(() => {}, 1000)"),
  });
  assert.ok(a.pid > 0, "the pid is known once create resolves");
  await assert.rejects(
    manager.create({ workspaceId: "ws", cwd: process.cwd(), cols: 80, rows: 24, argv: node("0") }),
    TerminalCapError,
  );
  assert.ok(manager.busy("ws"));
  await manager.close(a.id, 200);
  assert.ok(!manager.busy("ws"));
  manager.enabled = false;
  await assert.rejects(
    manager.create({ workspaceId: "ws", cwd: process.cwd(), cols: 80, rows: 24 }),
    TerminalsDisabledError,
  );
  assert.deepEqual(manager.capability(), { feature: false, reason: "terminals: false" });

  const broken = new TerminalManager({
    publish: () => undefined,
    loader: () => {
      throw new Error("Cannot find module 'node-pty'");
    },
  });
  assert.equal(broken.status().available, false);
  assert.match(broken.status().error ?? "", /node-pty/);
  await assert.rejects(
    broken.create({ workspaceId: "ws", cwd: process.cwd(), cols: 80, rows: 24 }),
    TerminalsUnavailableError,
  );
  assert.equal(broken.capability().feature, false);
  resetPtyCache();
});
