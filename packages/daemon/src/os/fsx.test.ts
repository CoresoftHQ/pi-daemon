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
  rmSync(dir, { recursive: true, force: true });
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
    const t0 = Date.now();
    while (events.length === 0 && Date.now() - t0 < 4000) await new Promise((r) => setTimeout(r, 50));
    assert.ok(events.length >= 1, `expected an event (mode=${w.mode})`);
    assert.ok(
      events.flat().some((p) => p.includes("hello.txt")),
      `paths: ${JSON.stringify(events)}`,
    );
  } finally {
    w.close();
  }
});
