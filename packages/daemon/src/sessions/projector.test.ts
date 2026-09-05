import assert from "node:assert/strict";
import { test } from "node:test";
import { Projector } from "./projector.ts";

function make() {
  let n = 0;
  return new Projector({
    sessionId: "s",
    workspaceId: "w",
    cwd: "/w",
    mintRunId: () => `run${++n}`,
    now: () => 1000,
  });
}

const user = { role: "user", content: "hi", timestamp: 1 };
const assistant = (text: string, stopReason = "stop") => ({
  role: "assistant",
  content: [{ type: "text", text }],
  provider: "p",
  model: "m",
  stopReason,
  timestamp: 2,
  usage: {
    input: 1,
    output: 2,
    cacheRead: 0,
    cacheWrite: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
});

test("a turn: user item is announced then made authoritative by the snapshot; assistant streams then finishes", () => {
  const p = make();
  const r1 = p.apply({ type: "agent_start" });
  assert.equal(r1.runStarted, "run1");
  assert.equal(p.state.phase, "turn");
  assert.equal(p.state.runId, "run1");

  const started = p.apply({ type: "message_start", message: user });
  assert.equal(started.progress[0]?.type, "item_started");
  assert.equal(p.state.transcript.length, 0, "not authoritative yet");
  const ended = p.apply({ type: "message_end", message: user });
  assert.equal(ended.progress.length, 0, "no item_finished for a user item");
  assert.equal(ended.snapshot, true);
  assert.equal(p.state.transcript.length, 1);

  p.apply({ type: "message_start", message: { role: "assistant", content: [], provider: "p", model: "m" } });
  p.apply({ type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } });
  const d1 = p.apply({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hel" },
  });
  const d2 = p.apply({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "lo" },
  });
  assert.equal(d1.progress[0]?.type, "assistant_delta");
  assert.equal(d2.progress[0]?.type, "assistant_delta");
  const end = p.apply({ type: "message_end", message: assistant("hello") });
  const finished = end.progress.find((x) => x.type === "item_finished");
  assert.ok(finished && finished.type === "item_finished");
  assert.equal(finished.item.role, "assistant");
  if (finished.item.role === "assistant") {
    assert.equal(finished.item.status, "complete");
    assert.equal(finished.item.content[0]?.type === "text" && finished.item.content[0].text, "hello");
    assert.equal(finished.item.usage?.totalTokens, 3);
  }
  const settled = p.apply({ type: "agent_settled" });
  assert.equal(settled.runSettled, "run1");
  assert.equal(p.state.phase, "idle");
  assert.equal(p.state.transcript.length, 2);
});

test("revision increases on every authoritative change and never otherwise", () => {
  const p = make();
  const r0 = p.state.revision;
  p.apply({ type: "message_start", message: user });
  assert.equal(p.state.revision, r0, "progress alone does not bump");
  p.apply({ type: "message_end", message: user });
  assert.equal(p.state.revision, r0 + 1);
  p.apply({ type: "agent_start" });
  assert.equal(p.state.revision, r0 + 2);
});

test("tool calls: the assistant's toolCall input is carried into the tool item", () => {
  const p = make();
  p.apply({ type: "agent_start" });
  p.apply({ type: "message_start", message: { role: "assistant", content: [] } });
  p.apply({
    type: "message_update",
    assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, id: "c1", toolName: "bash" },
  });
  p.apply({
    type: "message_update",
    assistantMessageEvent: {
      type: "toolcall_end",
      contentIndex: 0,
      toolCall: { id: "c1", name: "bash", arguments: { command: "ls" } },
    },
  });
  p.apply({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } }],
      stopReason: "toolUse",
    },
  });
  const start = p.apply({
    type: "tool_execution_start",
    toolCallId: "c1",
    toolName: "bash",
    args: { command: "ls" },
  });
  assert.equal(start.progress[0]?.type, "item_started");
  p.apply({
    type: "tool_execution_update",
    toolCallId: "c1",
    toolName: "bash",
    partialResult: { content: [{ type: "text", text: "a" }] },
  });
  const end = p.apply({
    type: "tool_execution_end",
    toolCallId: "c1",
    toolName: "bash",
    result: { content: [{ type: "text", text: "a\nb" }] },
    isError: false,
  });
  assert.equal(end.snapshot, true);
  const tool = p.state.transcript.at(-1);
  assert.ok(tool?.role === "tool");
  if (tool?.role === "tool") {
    assert.deepEqual(tool.input, { command: "ls" });
    assert.equal(tool.status, "complete");
  }
  const asst = p.state.transcript.at(-2);
  assert.ok(asst?.role === "assistant" && asst.stopReason === "toolUse");
});

test("an aborted assistant message and an errored one keep their reasons", () => {
  const p = make();
  p.apply({ type: "message_start", message: { role: "assistant", content: [] } });
  p.apply({ type: "message_end", message: assistant("partial", "aborted") });
  p.apply({ type: "message_start", message: { role: "assistant", content: [] } });
  p.apply({ type: "message_end", message: { ...assistant("", "error"), errorMessage: "rate limited" } });
  const [a, b] = p.state.transcript;
  assert.ok(a?.role === "assistant" && a.status === "aborted" && a.stopReason === "aborted");
  assert.ok(b?.role === "assistant" && b.status === "error" && b.errorMessage === "rate limited");
});

test("loadEntries keeps pi's durable ids and skips non-message entries", () => {
  const p = make();
  p.loadEntries([
    { type: "message", id: "e1", parentId: null, timestamp: "2026-01-01T00:00:00Z", message: user },
    { type: "compaction", id: "e2", parentId: "e1" },
    {
      type: "message",
      id: "e3",
      parentId: "e2",
      timestamp: "2026-01-01T00:00:01Z",
      message: assistant("ok"),
    },
    {
      type: "message",
      id: "e4",
      parentId: "e3",
      timestamp: "2026-01-01T00:00:02Z",
      message: {
        role: "toolResult",
        toolCallId: "c9",
        toolName: "read",
        content: [{ type: "text", text: "x" }],
        isError: false,
      },
    },
  ]);
  assert.deepEqual(
    p.state.transcript.map((i) => i.id),
    ["e1", "e3", "e4"],
  );
  assert.equal(p.state.transcript[2]?.role, "tool");
});

test("markInterrupted records the run and abandons streaming items", () => {
  const p = make();
  p.apply({ type: "agent_start" });
  p.apply({ type: "message_start", message: { role: "assistant", content: [] } });
  p.markInterrupted("runner_crashed", "boom");
  assert.equal(p.state.phase, "idle");
  assert.deepEqual(p.state.interrupted, {
    runId: "run1",
    at: 1000,
    reason: "runner_crashed",
    detail: "boom",
  });
  assert.equal(p.state.transcript.length, 0);
  p.apply({ type: "agent_start" });
  assert.equal(p.state.interrupted, undefined, "a new run clears it");
});
