import assert from "node:assert/strict";
import { test } from "node:test";
import { DialogTable } from "./dialogs.ts";

const confirm = (id: string) => ({
  type: "extension_ui_request" as const,
  id,
  method: "confirm",
  title: "Run?",
});

test("first answer wins; the second gets already-resolved naming the winner", () => {
  const t = new DialogTable({ now: () => 5 });
  const d = t.open("s1", confirm("u1"));
  assert.equal(d.dialogId, "s1:u1");
  assert.equal(d.blocking, true);
  const first = t.respond(d.dialogId, { confirmed: true }, "phone");
  assert.ok(first.ok);
  const second = t.respond(d.dialogId, { confirmed: false }, "laptop");
  assert.deepEqual(second, {
    ok: false,
    reason: "already-resolved",
    resolution: "answered",
    answeredBy: "phone",
  });
  assert.deepEqual(t.respond("s1:nope", { cancelled: true }, "x"), { ok: false, reason: "unknown" });
});

test("fire-and-forget methods are not tracked", () => {
  const t = new DialogTable();
  const n = t.open("s1", { type: "extension_ui_request", id: "n1", method: "notify", message: "hi" });
  assert.equal(n.blocking, false);
  assert.equal(t.openCount, 0);
});

test("a runner exit closes every open dialog of that session only", () => {
  const t = new DialogTable();
  t.open("s1", confirm("a"));
  t.open("s1", confirm("b"));
  t.open("s2", confirm("c"));
  const closed = t.closeAllForSession("s1");
  assert.deepEqual(
    closed.map((c) => c.resolution),
    ["runner_exited", "runner_exited"],
  );
  assert.equal(t.openCount, 1);
  assert.deepEqual(t.respond("s1:a", { confirmed: true }, "late"), {
    ok: false,
    reason: "already-resolved",
    resolution: "runner_exited",
  });
});
