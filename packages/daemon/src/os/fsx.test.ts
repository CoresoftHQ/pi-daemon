import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import { readJsonSync, watchDirectory, writeFileAtomicSync, writeJsonAtomicSync } from "./fsx.ts";
import { platform, tmpDir } from "./paths.ts";

let dir: string;
before(() => {
  dir = mkdtempSync(path.join(tmpDir(), "pi-daemon-fsx-"));
});
after(() => {
  // A directory that was being watched can still be held for a moment on Windows after the
  // watcher closes; rmSync retries EBUSY / EPERM / ENOTEMPTY for exactly this.
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

test("atomic write creates, then replaces, and leaves no temp files", () => {
  const f = path.join(dir, "a.txt");
  writeFileAtomicSync(f, "one");
  assert.equal(readFileSync(f, "utf8"), "one");
  writeFileAtomicSync(f, Buffer.from("two"));
  assert.equal(readFileSync(f, "utf8"), "two");
  assert.deepEqual(
    readdirSync(dir).filter((n) => n.endsWith(".tmp")),
    [],
  );
});

test("atomic replace preserves an executable mode", { skip: platform === "win32" }, () => {
  const f = path.join(dir, "run.sh");
  writeFileSync(f, "#!/bin/sh\n");
  chmodSync(f, 0o755);
  writeFileAtomicSync(f, "#!/bin/sh\necho hi\n");
  assert.equal(statSync(f).mode & 0o777, 0o755);
});

test("json helpers round-trip and return undefined for a missing file", () => {
  const f = path.join(dir, "x.json");
  assert.equal(readJsonSync(f), undefined);
  writeJsonAtomicSync(f, { a: [1, 2], b: "c" });
  assert.deepEqual(readJsonSync(f), { a: [1, 2], b: "c" });
});

test("watchDirectory reports a changed path, debounced", async () => {
  const wdir = path.join(dir, "watched");
  writeFileSync(path.join(dir, "placeholder"), "");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(wdir);
  const events: string[][] = [];
  const w = watchDirectory(wdir, (e) => events.push(e.paths), { debounceMs: 100 });
  try {
    await new Promise((r) => setTimeout(r, 150));
    writeFileSync(path.join(wdir, "hello.txt"), "1");
    writeFileSync(path.join(wdir, "hello.txt"), "2");
    // Batches may be coalesced or early (FSEvents can deliver the directory's own creation
    // first); the contract is only that the path eventually appears. Wait for it.
    const t0 = Date.now();
    const seen = () => events.flat().some((p) => p.includes("hello.txt"));
    while (!seen() && Date.now() - t0 < 4000) await new Promise((r) => setTimeout(r, 50));
    assert.ok(events.length >= 1, `expected an event (mode=${w.mode})`);
    assert.ok(seen(), `paths: ${JSON.stringify(events)} (mode=${w.mode})`);
  } finally {
    w.close();
  }
});
