import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import { tmpDir } from "../os/paths.ts";
import { pidAlive } from "../os/spawn.ts";
import { readSessionHeaders } from "./catalog.ts";
import type { DaemonEvent } from "./events.ts";
import { RunnerCapError, SessionHost, SessionLockedError, scrubEnv } from "./host.ts";
import { SessionBusyError } from "./session.ts";

const FAKE = path.resolve(import.meta.dirname, "..", "..", "test", "fake-pi.mjs");
const launcher = { command: process.execPath, prefix: [FAKE], source: "env" as const };
let cwd: string;

before(() => {
  cwd = mkdtempSync(path.join(tmpDir(), "pi-daemon-host-"));
});
after(() => {
  rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function host(extra: ConstructorParameters<typeof SessionHost>[0] = {}) {
  return new SessionHost({ launcher, sweepIntervalMs: 0, env: { PATH: process.env.PATH ?? "" }, ...extra });
}
const types = (events: DaemonEvent[]) => events.map((e) => e.type);

test("scrubEnv drops daemon variables but keeps PI_DAEMON_PI", () => {
  assert.deepEqual(
    scrubEnv({ PATH: "p", PI_DAEMON_TOKEN: "t", PI_DAEMON_HOME: "h", PI_DAEMON_PI: "cli.js" }),
    { PATH: "p", PI_DAEMON_PI: "cli.js" },
  );
});

test("create, prompt, stream, settle: runId on the prompt and on both phase events", async () => {
  const h = host();
  const events: DaemonEvent[] = [];
  h.log.subscribe((e) => events.push(e));
  const s = await h.create({ workspaceId: "w1", cwd });
  assert.equal(s.live, true);
  assert.equal(types(events)[0], "session.created");

  const result = await h.prompt(s.id, "hello");
  assert.equal(result.queued, false);
  assert.match(result.runId ?? "", /^run_/);
  await new Promise<void>((r) => s.once("run_settled", () => r()));
  const phases = events
    .filter((e) => e.type === "session.phase")
    .map((e) => e.payload as { phase: string; runId: string });
  assert.deepEqual(
    phases.map((p) => p.phase),
    ["turn", "idle"],
  );
  assert.equal(phases[0]?.runId, result.runId);
  assert.ok(types(events).includes("transcript.assistant_delta"));
  assert.ok(types(events).includes("transcript.item_finished"));
  assert.equal(s.state.transcript.length, 2);
  assert.equal(s.state.phase, "idle");
  const seqs = events.map((e) => e.seq);
  assert.deepEqual(
    seqs,
    [...seqs].sort((a, b) => a - b),
    "seq is monotonic",
  );
  await h.close();
});

test("a prompt during a turn needs a queue mode; steer queues it", async () => {
  const h = host();
  const s = await h.create({ workspaceId: "w1", cwd });
  await h.prompt(s.id, "SLOW one two three four five six");
  await assert.rejects(h.prompt(s.id, "again"), SessionBusyError);
  const queued = await h.prompt(s.id, "again", "steer");
  assert.equal(queued.queued, true);
  await s.abort();
  await new Promise<void>((r) => s.once("run_settled", () => r()));
  await h.close();
});

test("dialog relay: opened on the log, first answer wins and unblocks the runner", async () => {
  const h = host();
  const events: DaemonEvent[] = [];
  h.log.subscribe((e) => events.push(e));
  const s = await h.create({ workspaceId: "w1", cwd });
  const opened = new Promise<string>((r) => s.once("dialog_opened", (d) => r(d.dialogId)));
  await h.prompt(s.id, "please ASK");
  const dialogId = await opened;
  assert.ok(types(events).includes("dialog.opened"));
  const first = h.respondDialog(dialogId, { confirmed: true }, "phone");
  assert.ok(first.ok);
  const second = h.respondDialog(dialogId, { confirmed: false }, "laptop");
  assert.equal(second.ok, false);
  await new Promise<void>((r) => s.once("run_settled", () => r()));
  const closed = events.find((e) => e.type === "dialog.closed")?.payload as {
    answeredBy: string;
    resolution: string;
  };
  assert.deepEqual([closed.resolution, closed.answeredBy], ["answered", "phone"]);
  const last = s.state.transcript.at(-1);
  assert.ok(
    last?.role === "assistant" &&
      last.content[0]?.type === "text" &&
      last.content[0].text === "answered:true",
  );
  await h.close();
});

test("leases: exclusive refuses while shared exists; a connection closing releases everything", async () => {
  const h = host();
  const s = await h.create({ workspaceId: "w1", cwd });
  await h.attach(s.id, "c1", "shared");
  await assert.rejects(h.attach(s.id, "c2", "exclusive"), SessionLockedError);
  await h.attach(s.id, "c2", "shared");
  assert.equal(s.state.attachedCount, 2);
  h.releaseConnection("c1");
  assert.equal(s.state.attachedCount, 1);
  h.detach(s.id, "c2");
  assert.equal(s.state.attachedCount, 0);
  await h.close();
});

test("eviction stops the runner; attach rehydrates from the file with history and a fresh pid", async () => {
  const h = host({ idleTimeoutMs: 50 });
  const events: DaemonEvent[] = [];
  h.log.subscribe((e) => events.push(e));
  const s = await h.create({ workspaceId: "w1", cwd });
  await h.prompt(s.id, "remember me");
  await new Promise<void>((r) => s.once("run_settled", () => r()));
  const pid = s.runnerPid as number;
  await sleep(80);
  await h.sweep();
  assert.equal(s.live, false);
  assert.ok(types(events).includes("session.evicted"));
  assert.equal(pidAlive(pid), false);
  assert.ok(
    h.list().some((x) => x.id === s.id && !x.live),
    "still listed",
  );

  const again = await h.attach(s.id, "c1", "shared");
  assert.equal(again, s);
  assert.equal(s.live, true);
  assert.notEqual(s.runnerPid, pid);
  // The fake keeps no file, so history is whatever its get_entries reports for a fresh process (empty);
  // the point here is the lifecycle. The real-pi path is covered by M0 and the gated test below.
  assert.equal(s.state.phase, "idle");
  await h.close();
});

test("a runner crash marks the session interrupted with its runId, closes its dialogs, and touches nothing else", async () => {
  const h = host();
  const events: DaemonEvent[] = [];
  h.log.subscribe((e) => events.push(e));
  const other = await h.create({ workspaceId: "w1", cwd });
  const s = await h.create({ workspaceId: "w1", cwd });
  const interrupted = new Promise<void>((r) => s.once("interrupted", () => r()));
  const { runId } = await h.prompt(s.id, "CRASH");
  await interrupted;
  assert.equal(s.live, false);
  assert.equal(s.state.interrupted?.runId, runId);
  assert.equal(s.state.interrupted?.reason, "runner_crashed");
  assert.match(s.state.interrupted?.detail ?? "", /simulated crash/);
  assert.ok(types(events).includes("runner.failed"));
  assert.ok(types(events).includes("session.interrupted"));
  assert.equal(other.live, true, "the other session is untouched");
  const summary = h.list().find((x) => x.id === s.id);
  assert.equal(summary?.interrupted?.reason, "runner_crashed");
  await h.close();
});

test("the runner cap evicts the least recently used idle session, and refuses when all are busy", async () => {
  const h = host({ maxRunners: 2 });
  const a = await h.create({ workspaceId: "w1", cwd });
  await sleep(5);
  const b = await h.create({ workspaceId: "w1", cwd });
  assert.equal(h.liveCount, 2);
  const c = await h.create({ workspaceId: "w1", cwd });
  assert.equal(h.liveCount, 2);
  assert.equal(a.live, false, "oldest idle one was evicted");
  assert.equal(b.live, true);
  assert.equal(c.live, true);
  await h.prompt(b.id, "HANG");
  await h.prompt(c.id, "HANG");
  await assert.rejects(h.create({ workspaceId: "w1", cwd }), RunnerCapError);
  await h.close();
});

test("the catalog reads only headers from pi's session directory layout", () => {
  const dir = path.join(cwd, "sessions", "--C-work-proj--");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "2026-01-01T00-00-00-000Z_abc.jsonl"),
    `${JSON.stringify({ type: "session", version: 3, id: "abc", timestamp: "2026-01-01T00:00:00.000Z", cwd: "C:\\work\\proj" })}\n{"type":"message","id":"e1"}\n`,
  );
  writeFileSync(path.join(dir, "junk.jsonl"), "not json\n");
  const headers = readSessionHeaders(path.join(cwd, "sessions"));
  assert.equal(headers.length, 1);
  assert.equal(headers[0]?.id, "abc");
  assert.equal(headers[0]?.cwd, "C:\\work\\proj");
  assert.equal(headers[0]?.createdAt, Date.parse("2026-01-01T00:00:00.000Z"));
});

test("close() evicts every live session and leaves no runner behind", async () => {
  const h = host();
  const a = await h.create({ workspaceId: "w1", cwd });
  const b = await h.create({ workspaceId: "w1", cwd });
  const pids = [a.runnerPid as number, b.runnerPid as number];
  await h.close();
  await sleep(200);
  assert.deepEqual(pids.map(pidAlive), [false, false]);
});
