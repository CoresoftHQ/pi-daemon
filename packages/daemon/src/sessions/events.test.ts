import assert from "node:assert/strict";
import { test } from "node:test";
import { EventLog } from "./events.ts";

test("seq is global and monotonic across scopes", () => {
  const log = new EventLog({ now: () => 1 });
  const a = log.append("daemon", "x", {});
  const b = log.append("session:1", "y", {});
  const c = log.append("workspace:2", "z", {});
  assert.deepEqual([a.seq, b.seq, c.seq], [1, 2, 3]);
});

test("replay from a watermark returns only later events; scope filters leave gaps that are not loss", () => {
  const log = new EventLog();
  log.append("session:1", "a", 1);
  log.append("session:2", "b", 2);
  log.append("session:1", "c", 3);
  log.append("daemon", "d", 4);
  const all = log.replay(1);
  assert.deepEqual(
    all.events.map((e) => e.seq),
    [2, 3, 4],
  );
  assert.equal(all.gap, false);
  const filtered = log.replay(0, new Set(["session:1"]));
  assert.deepEqual(
    filtered.events.map((e) => e.seq),
    [1, 3],
  );
  assert.equal(filtered.watermark, 4);
  assert.deepEqual(log.replay(4), { events: [], gap: false, watermark: 4 });
});

test("a watermark older than the ring is a gap, not a partial replay", () => {
  const log = new EventLog({ maxEvents: 3 });
  for (let i = 0; i < 5; i++) log.append("daemon", "e", i);
  assert.equal(log.oldest, 3);
  assert.equal(log.replay(1).gap, true, "seq 2 is gone");
  assert.equal(log.replay(2).gap, false, "seq 3 onward is intact");
  assert.deepEqual(
    log.replay(2).events.map((e) => e.seq),
    [3, 4, 5],
  );
});

test("the ring is bounded by bytes as well as count", () => {
  const log = new EventLog({ maxEvents: 1000, maxBytes: 600 });
  for (let i = 0; i < 20; i++) log.append("daemon", "big", "x".repeat(100));
  assert.ok(log.size < 20 && log.size >= 1, `size ${log.size}`);
});

test("subscribers see every event, and one failing subscriber does not stop the others", () => {
  const log = new EventLog();
  const seen: number[] = [];
  log.subscribe(() => {
    throw new Error("boom");
  });
  const unsub = log.subscribe((e) => seen.push(e.seq));
  log.append("daemon", "a", null);
  unsub();
  log.append("daemon", "b", null);
  assert.deepEqual(seen, [1]);
});
