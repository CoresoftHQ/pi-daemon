import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import type { TestContext } from "node:test";
import { after, before, test } from "node:test";
import { tmpDir } from "../os/paths.ts";
import { pidAlive } from "../os/spawn.ts";
import type { RpcEvent, RpcState } from "./rpc.ts";
import type { RunnerSpawnOptions } from "./runner.ts";
import { buildArgs, Runner, RunnerExitedError } from "./runner.ts";

const FAKE = path.resolve(import.meta.dirname, "..", "..", "test", "fake-pi.mjs");
const launcher = { command: process.execPath, prefix: [FAKE], source: "env" as const };
let cwd: string;

before(() => {
  cwd = mkdtempSync(path.join(tmpDir(), "pi-daemon-runner-"));
});
after(() => {
  rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Spawn a runner that is killed when the test ends, however it ends. A leaked runner keeps
 * its pipes open and would hold `node --test` until the CI job's timeout.
 */
function spawnFor(t: TestContext, options: Partial<RunnerSpawnOptions> = {}): Runner {
  const r = Runner.spawn({ cwd, launcher, ...options });
  t.after(() => r.kill());
  return r;
}

async function waitUntil(pred: () => boolean, timeoutMs = 5000): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > timeoutMs) throw new Error("waitUntil timed out");
    await sleep(50);
  }
}

test("buildArgs maps options to pi flags", () => {
  const args = buildArgs({
    cwd: ".",
    isolate: true,
    extensions: ["./x.ts"],
    tools: ["read", "bash"],
    trust: "no-approve",
    session: "abc",
    name: "n",
  });
  assert.deepEqual(args, [
    "--mode",
    "rpc",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "-e",
    "./x.ts",
    "--tools",
    "read,bash",
    "--no-approve",
    "--session",
    "abc",
    "--name",
    "n",
  ]);
});

test("spawn, correlate a command, stream a turn, stop gracefully", async (t) => {
  const r = spawnFor(t, { session: "sess-1" });
  const events: string[] = [];
  r.on("event", (e: RpcEvent) => events.push(e.type));

  const state = await r.send<RpcState>({ type: "get_state" });
  assert.equal(state.success, true);
  assert.equal(state.data?.sessionId, "sess-1");
  assert.equal(r.state, "running");

  // Register before prompting: on POSIX a whole short turn can arrive in one chunk.
  const settled = r.waitForEvent("agent_settled");
  const p = await r.send({ type: "prompt", message: "hello" });
  assert.equal(p.success, true);
  await settled;
  assert.deepEqual(events.slice(0, 4), ["agent_start", "turn_start", "message_start", "message_end"]);
  assert.ok(events.includes("message_update"));
  assert.equal(events.at(-1), "agent_settled");

  const msgs = await r.send<{ messages: unknown[] }>({ type: "get_messages" });
  assert.equal(msgs.data?.messages.length, 2);

  const exit = await r.stop({ graceMs: 3000 });
  assert.equal(exit.expected, true);
  assert.equal(exit.code, 0);
  assert.equal(r.state, "exited");
});

test("a dialog raised inside the runner blocks until answered; the answer reaches the model", async (t) => {
  const r = spawnFor(t);
  const deltas: string[] = [];
  r.on("event", (e: RpcEvent) => {
    const ev = e.assistantMessageEvent as { type?: string; delta?: string } | undefined;
    if (e.type === "message_update" && ev?.type === "text_delta") deltas.push(ev.delta ?? "");
  });
  const uiPromise = new Promise<{ id: string; method: string }>((resolve) =>
    r.once("ui_request", (req) => resolve({ id: req.id, method: req.method })),
  );
  await r.send({ type: "prompt", message: "please ASK me" });
  const req = await uiPromise;
  assert.equal(req.method, "confirm");
  await sleep(200);
  assert.equal(deltas.length, 0, "no reply streamed while the dialog is open");
  const settled = r.waitForEvent("agent_settled");
  assert.equal(r.respondUi(req.id, { confirmed: true }), true);
  await settled;
  assert.equal(deltas.join(""), "answered:true");
  await r.stop();
});

test("kill() takes the whole process tree, including a tool child", async (t) => {
  const r = spawnFor(t);
  const childPid = new Promise<number>((resolve) =>
    r.on("event", (e: RpcEvent) => {
      if (e.type === "fake_child") resolve(e.pid as number);
    }),
  );
  const settled = r.waitForEvent("agent_settled");
  await r.send({ type: "prompt", message: "SPAWN_CHILD" });
  const pid = await childPid;
  await settled;
  assert.equal(pidAlive(pid), true, "grandchild is running before the kill");
  const runnerPid = r.pid as number;

  const exited = new Promise<void>((resolve) => r.once("exit", () => resolve()));
  r.kill();
  await exited;
  await waitUntil(() => !pidAlive(pid) && !pidAlive(runnerPid), 5000);
  assert.equal(pidAlive(pid), false, "grandchild died with the runner");
  assert.equal(r.exitInfo?.expected, true);
});

test("a crash is reported as an unexpected exit with a stderr tail; pending commands reject", async (t) => {
  const r = spawnFor(t);
  const exit = new Promise<{ expected: boolean; code: number | null; stderrTail: string }>((resolve) =>
    r.once("exit", resolve),
  );
  await r.send({ type: "prompt", message: "CRASH" });
  const e = await exit;
  assert.equal(e.expected, false);
  assert.equal(e.code, 3);
  assert.match(e.stderrTail, /simulated crash/);
  await assert.rejects(r.send({ type: "get_state" }), RunnerExitedError);
  assert.equal(r.respondUi("nope", { cancelled: true }), false);
});

test("stop() falls back to tree-kill when the runner ignores stdin EOF", async (t) => {
  const r = spawnFor(t, { extraArgs: ["--ignore-stdin-end"] });
  await r.send({ type: "get_state" });
  const t0 = Date.now();
  const exit = await r.stop({ graceMs: 300 });
  assert.equal(exit.expected, true);
  assert.ok(Date.now() - t0 >= 250, "waited for the grace period");
  assert.ok(Date.now() - t0 < 5000, "then killed");
  assert.equal(r.state, "exited");
});

test("abort mid-turn marks the assistant message aborted", async (t) => {
  const r = spawnFor(t);
  const firstUpdate = r.waitForEvent("message_update");
  await r.send({ type: "prompt", message: "SLOW one two three four five six seven eight" });
  await firstUpdate;
  const settled = r.waitForEvent("agent_settled");
  await r.send({ type: "abort" });
  await settled;
  const msgs = await r.send<{ messages: Array<{ role: string; stopReason?: string }> }>({
    type: "get_messages",
  });
  assert.equal(msgs.data?.messages.at(-1)?.stopReason, "aborted");
  await r.stop();
});

test("a missing pi is a synchronous PiNotFoundError, not a crash", () => {
  assert.throws(() => Runner.spawn({ cwd, env: { PATH: "" } }), /pi was not found/);
});

test("the real pi on PATH spawns through the resolved launcher and answers get_state", {
  skip: process.env.PI_DAEMON_REAL_PI !== "1" ? "set PI_DAEMON_REAL_PI=1" : false,
}, async (t) => {
  const r = Runner.spawn({ cwd, isolate: true, noTools: true, noSession: true });
  t.after(() => r.kill());
  const state = await r.send<RpcState>({ type: "get_state" });
  assert.equal(state.success, true);
  assert.ok(state.data?.sessionId);
  const exit = await r.stop({ graceMs: 3000 });
  assert.equal(exit.expected, true);
});
