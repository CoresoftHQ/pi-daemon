// The client against a real daemon (the composition root with the fake pi): pair, capabilities,
// a session and a prompt, the event stream with resume, a dialog, files with ETags, a terminal.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { DEFAULT_CONFIG } from "../../daemon/src/cli/config.ts";
import type { RunningDaemon } from "../../daemon/src/cli/daemon.ts";
import { startDaemon } from "../../daemon/src/cli/daemon.ts";
import { createLogger } from "../../daemon/src/os/log.ts";
import { appDirs } from "../../daemon/src/os/paths.ts";
import { DaemonError, PiDaemonClient } from "./index.ts";
import type { Event } from "./types.ts";

const FAKE = path.resolve(import.meta.dirname, "..", "..", "daemon", "test", "fake-pi.mjs");
const launcher = { command: process.execPath, prefix: [FAKE], source: "env" as const };

let root: string;
let daemon: RunningDaemon;
let base: string;
let client: PiDaemonClient;
let workspaceId: string;

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

async function waitFor<T>(pred: () => T | undefined, ms = 15_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = pred();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error(`timed out after ${ms}ms`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

before(async () => {
  root = mkdtempSync(path.join(os.tmpdir(), "pi-daemon-client-"));
  const ws = path.join(root, "workspace");
  mkdirSync(ws);
  writeFileSync(path.join(ws, "README.md"), "# hello\n");
  const port = await freePort();
  daemon = await startDaemon({
    dirs: appDirs("pi-daemon", { PI_DAEMON_HOME: root }),
    config: { ...DEFAULT_CONFIG, port, limits: { ...DEFAULT_CONFIG.limits, replayRingEvents: 100 } },
    version: "0.0.0-test",
    launcher,
    env: process.env, // a real shell needs more than PATH; the daemon scrubs its own secrets out
    logger: createLogger({ level: "error", stderr: false }),
  });
  workspaceId = (await daemon.workspaces.register(ws)).workspaces[0]?.id ?? "";
  base = `http://127.0.0.1:${port}`;
});
after(async () => {
  await daemon.stop("test");
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("pair, then capabilities; a bad code is a DaemonError with the daemon's code", async () => {
  const code = daemon.pairing.issue().code;
  const paired = await PiDaemonClient.pair(base, { code, deviceName: "test", platform: "node" });
  assert.equal(paired.daemonId, daemon.identity.id);
  assert.equal(paired.role, "owner");
  client = new PiDaemonClient({ baseUrl: base, token: paired.token });
  const caps = await client.capabilities();
  assert.ok(caps.features.includes("files.write"));
  await assert.rejects(
    PiDaemonClient.pair(base, { code: "NOPE-NOPE", deviceName: "x", platform: "x" }),
    (e: unknown) => e instanceof DaemonError && e.status >= 400 && typeof e.code === "string",
  );
  await assert.rejects(
    new PiDaemonClient({ baseUrl: base, token: "pid_bad_bad" }).capabilities(),
    (e: unknown) => e instanceof DaemonError && e.status === 401,
  );
});

test("a session in the default workspace, a prompt with an idempotency key, and the transcript", async () => {
  const session = await client.sessions.create();
  assert.equal(session.workspaceId, workspaceId);
  const key = crypto.randomUUID();
  const first = await client.sessions.prompt(session.id, "hello", { idempotencyKey: key });
  assert.ok(first.runId);
  const again = await client.sessions.prompt(session.id, "hello", { idempotencyKey: key });
  assert.deepEqual(again, first, "a retry with the same key returns the same answer");
  const done = await (async () => {
    const deadline = Date.now() + 15_000;
    for (;;) {
      const s = await client.sessions.get(session.id);
      if (s.phase === "idle" && s.transcript.length >= 2) return s;
      if (Date.now() > deadline) throw new Error("turn never settled");
      await new Promise((r) => setTimeout(r, 50));
    }
  })();
  assert.equal(done.transcript[0]?.role, "user");
  const list = await client.sessions.list(workspaceId);
  assert.ok(list.sessions.some((s) => s.id === session.id));
});

test("the event stream: scoped events, resume from since, snapshot.required on a stale watermark", async (t) => {
  const session = await client.sessions.create();
  const seen: Event[] = [];
  const stream = client.events({ scopes: [`session:${session.id}`] });
  t.after(() => stream.close());
  stream.on("*", (e) => seen.push(e));
  await new Promise<void>((resolve) => stream.onState((s) => s === "open" && resolve()));
  await client.sessions.prompt(session.id, "hello again");
  const phase = await waitFor(() => seen.find((e) => e.type === "session.phase"));
  assert.equal(phase.scope, `session:${session.id}`);
  await waitFor(() => seen.find((e) => e.type === "session.changed"));
  assert.ok(stream.since > 0);

  // resume: a second stream from the first event's seq replays what followed
  const first = seen[0]?.seq ?? 0;
  const replay: Event[] = [];
  const resumed = client.events({ scopes: [`session:${session.id}`], since: first });
  t.after(() => resumed.close());
  resumed.on("*", (e) => replay.push(e));
  await waitFor(() => (replay.length >= seen.length - 1 ? true : undefined));
  assert.equal(replay[0]?.seq, seen[1]?.seq, "replay starts right after since");

  // a watermark older than the ring (100 events here): the first frame says re-read state, and
  // `since` jumps ahead to the watermark
  for (let i = 0; i < 60; i++) {
    const g = await client.groups.create({ name: `churn-${i}` });
    await client.groups.delete(g.id);
  }
  const stale: Event[] = [];
  const staleStream = client.events({ since: 1 });
  t.after(() => staleStream.close());
  staleStream.on("*", (e) => stale.push(e));
  const required = await waitFor(() => stale.find((e) => e.type === "snapshot.required"));
  assert.equal(staleStream.since, (required.payload as { watermark: number }).watermark);
});

test("a dialog: the fake pi asks, the client answers, first answer wins", async (t) => {
  const session = await client.sessions.create();
  const opened: Event<"dialog.opened">[] = [];
  const stream = client.events({ scopes: [`session:${session.id}`] });
  t.after(() => stream.close());
  stream.on("dialog.opened", (e) => opened.push(e));
  await new Promise<void>((resolve) => stream.onState((s) => s === "open" && resolve()));
  await client.sessions.prompt(session.id, "please ASK me");
  const dialog = await waitFor(() => opened[0]);
  assert.equal(dialog.payload.request.method, "confirm");
  const answer = await client.dialogs.respond(dialog.payload.dialogId, { confirmed: true });
  assert.equal(answer.dialogId, dialog.payload.dialogId);
  await assert.rejects(
    client.dialogs.respond(dialog.payload.dialogId, { confirmed: false }),
    (e: unknown) => e instanceof DaemonError && e.status === 409 && e.code === "already_resolved",
  );
});

test("files: read with ETag, write with If-Match, a stale write is refused, tree and diff", async () => {
  const readme = await client.workspaces.file(workspaceId, "README.md");
  assert.ok(readme);
  assert.equal(readme.text(), "# hello\n");
  assert.ok(readme.etag.startsWith('"'));
  assert.equal(await client.workspaces.file(workspaceId, "README.md", { ifNoneMatch: readme.etag }), null);
  await assert.rejects(
    client.workspaces.writeFile(workspaceId, "README.md", "# changed\n"),
    (e: unknown) => e instanceof DaemonError && e.status === 428,
  );
  const meta = await client.workspaces.writeFile(workspaceId, "README.md", "# changed\n", {
    ifMatch: readme.etag,
  });
  assert.notEqual(meta.etag, readme.etag);
  await assert.rejects(
    client.workspaces.writeFile(workspaceId, "README.md", "# again\n", { ifMatch: readme.etag }),
    (e: unknown) => e instanceof DaemonError && e.status === 412 && typeof e.extra.etag === "string",
  );
  await client.workspaces.writeFile(workspaceId, "src/new.ts", "export {};\n", {
    parents: true,
    createOnly: true,
  });
  const tree = await client.workspaces.tree(workspaceId, { depth: 2 });
  assert.ok(tree.entries.some((e) => e.name === "src" && e.children?.some((c) => c.name === "new.ts")));
  await client.workspaces.move(workspaceId, "src/new.ts", "src/moved.ts");
  await client.workspaces.deleteFile(workspaceId, "src", { recursive: true });
  await assert.rejects(
    client.workspaces.file(workspaceId, "../secret"),
    (e: unknown) => e instanceof DaemonError && e.status === 403 && e.code === "outside_workspace",
  );
  const stat = await client.workspaces.stat(workspaceId, "README.md");
  assert.equal(stat.size, "# changed\n".length);
});

test("a terminal: open, attach, snapshot first, type, resize, close", async (t) => {
  if (!daemon.terminals.capability().feature) return t.skip("no PTY here");
  const term = await client.terminals.open(workspaceId, { cols: 80, rows: 24 }); // the operator's shell
  let output = "";
  const frames: string[] = [];
  const conn = await client.terminals.attach(term.id, {
    onData: (b) => {
      output += new TextDecoder().decode(b);
    },
    onControl: (f) => frames.push(f.type),
  });
  await waitFor(() => (frames[0] === "snapshot" ? true : undefined));
  await waitFor(() => (output.length > 0 ? true : undefined)); // the prompt
  conn.send("echo marker-4242\r"); // Enter is a carriage return on a terminal, on every platform
  await waitFor(() => (output.includes("marker-4242") ? true : undefined));
  conn.resize(100, 30);
  await waitFor(() => (frames.includes("resize") ? true : undefined));
  assert.equal((await client.terminals.get(term.id)).cols, 100);
  const closed = await client.terminals.close(term.id, 200);
  assert.equal(closed.status, "exited");
  await waitFor(() => (frames.includes("exit") ? true : undefined));
});
