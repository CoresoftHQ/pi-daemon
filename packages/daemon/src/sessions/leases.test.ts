import assert from "node:assert/strict";
import { test } from "node:test";
import { LeaseTable } from "./leases.ts";

test("shared leases coexist; exclusive refuses while any other holder exists", () => {
  const t = new LeaseTable(() => 0);
  assert.equal(t.acquire("s", "c1", "shared").ok, true);
  assert.equal(t.acquire("s", "c2", "shared").ok, true);
  assert.deepEqual(t.acquire("s", "c3", "exclusive"), { ok: false, reason: "locked" });
  assert.equal(t.attachedCount("s"), 2);
  assert.equal(t.locked("s"), false);
});

test("an exclusive holder blocks shared acquisition by others but not its own re-acquire", () => {
  const t = new LeaseTable(() => 0);
  assert.equal(t.acquire("s", "c1", "exclusive").ok, true);
  assert.equal(t.locked("s"), true);
  assert.equal(t.acquire("s", "c2", "shared").ok, false);
  assert.equal(t.acquire("s", "c1", "shared").ok, true, "the same connection may change its own mode");
  assert.equal(t.locked("s"), false);
});

test("releaseAll drops everything a connection held and reports the sessions", () => {
  const t = new LeaseTable(() => 0);
  t.acquire("a", "c1", "shared");
  t.acquire("b", "c1", "shared");
  t.acquire("b", "c2", "shared");
  assert.deepEqual(t.releaseAll("c1").sort(), ["a", "b"]);
  assert.equal(t.attachedCount("a"), 0);
  assert.equal(t.attachedCount("b"), 1);
  assert.deepEqual(t.sessionsOf("c2"), ["b"]);
  assert.equal(t.release("b", "c9"), false);
});
