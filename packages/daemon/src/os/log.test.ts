import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import { createLogger, redactSecrets } from "./log.ts";
import { tmpDir } from "./paths.ts";

let dir: string;
before(() => {
  dir = mkdtempSync(path.join(tmpDir(), "pi-daemon-log-"));
});
after(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("redactSecrets replaces secret-looking keys at any depth", () => {
  const out = redactSecrets({
    token: "abc",
    nested: { apiKey: "k", Authorization: "Bearer x", fine: 1 },
    list: [{ password: "p" }, "keep"],
    err: new Error("boom"),
  });
  assert.deepEqual(out, {
    token: "[redacted]",
    nested: { apiKey: "[redacted]", Authorization: "[redacted]", fine: 1 },
    list: [{ password: "[redacted]" }, "keep"],
    err: { name: "Error", message: "boom", stack: (out.err as { stack: string }).stack },
  });
});

test("writes JSON lines with redaction and respects the level", () => {
  const file = path.join(dir, "d.log");
  const log = createLogger({ file, level: "info", now: () => 0 });
  log.debug("hidden");
  log.info("hello", { token: "t", n: 1 });
  log.child({ sessionId: "s1" }).warn("child");
  const lines = readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  assert.equal(lines.length, 2);
  assert.deepEqual(lines[0], {
    ts: "1970-01-01T00:00:00.000Z",
    level: "info",
    msg: "hello",
    token: "[redacted]",
    n: 1,
  });
  assert.deepEqual(lines[1], {
    ts: "1970-01-01T00:00:00.000Z",
    level: "warn",
    msg: "child",
    sessionId: "s1",
  });
});

test("rotates by size and caps the number of files", () => {
  const file = path.join(dir, "r.log");
  const log = createLogger({ file, maxBytes: 300, maxFiles: 2 });
  for (let i = 0; i < 40; i++) log.info(`line ${i} ${"x".repeat(40)}`);
  assert.ok(existsSync(`${file}.1`));
  assert.ok(existsSync(`${file}.2`));
  assert.ok(!existsSync(`${file}.3`));
});
