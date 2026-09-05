import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import { acquireLock, LockHeldError } from "./lock.ts";
import { tmpDir } from "./paths.ts";

let dir: string;
before(() => {
  dir = mkdtempSync(path.join(tmpDir(), "pi-daemon-lock-"));
});
after(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("acquire, then a second acquire against a live holder fails with LockHeldError", async () => {
  const file = path.join(dir, "a.lock");
  const lock = await acquireLock(
    file,
    { pid: process.pid, port: 1234, startedAt: Date.now() },
    { probe: async () => true },
  );
  assert.ok(existsSync(file));
  await assert.rejects(
    acquireLock(file, { pid: process.pid, port: 1, startedAt: 0 }, { probe: async () => true }),
    (e: unknown) => e instanceof LockHeldError && e.holder.port === 1234,
  );
  lock.release();
  assert.ok(!existsSync(file));
});

test("a stale lock (no answer on the port, pid gone) is taken over", async () => {
  const file = path.join(dir, "stale.lock");
  writeFileSync(file, JSON.stringify({ pid: 2 ** 22 + 999, port: 65000, startedAt: 0 }));
  const lock = await acquireLock(
    file,
    { pid: process.pid, port: 4321, startedAt: Date.now() },
    { probe: async () => false },
  );
  assert.equal(lock.info.port, 4321);
  lock.release();
});

test("a lock whose holder pid is alive but not serving is still held (we do not kill it)", async () => {
  const file = path.join(dir, "alive.lock");
  writeFileSync(file, JSON.stringify({ pid: process.pid, port: 65001, startedAt: 0 }));
  await assert.rejects(
    acquireLock(file, { pid: 1, port: 2, startedAt: 0 }, { probe: async () => false }),
    LockHeldError,
  );
  rmSync(file);
});

test("an unreadable lock file is treated as stale", async () => {
  const file = path.join(dir, "garbage.lock");
  writeFileSync(file, "not json");
  const lock = await acquireLock(
    file,
    { pid: process.pid, port: 5, startedAt: 0 },
    { probe: async () => false },
  );
  lock.release();
});
