// A fake `pi --mode rpc`, so the runner and session layers are testable with no pi installed,
// no provider credentials, and no network. Speaks the documented JSONL protocol (pi docs/rpc.md).
//
// Behaviour is driven by the prompt text:
//   "SPAWN_CHILD"  spawn a long-lived grandchild and report its pid as a `fake_child` event
//   "ASK"          raise a confirm dialog and block until answered; reply reports the answer
//   "CRASH"        exit(3) mid-turn
//   "HANG"         start a turn that never settles
//   "SLOW"         stream deltas with delays
// Flags: --session <id|path> sets the session id; --ignore-stdin-end keeps running after EOF
// (to exercise the tree-kill fallback); everything else is accepted and ignored.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import readline from "node:readline";

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const ignoreStdinEnd = args.includes("--ignore-stdin-end");
const sessionArg = flag("--session");
const sessionId = sessionArg && !/[\\/]/.test(sessionArg) ? sessionArg : randomUUID();
const sessionFile =
  sessionArg && /[\\/]/.test(sessionArg) ? sessionArg : `${process.cwd()}/fake-${sessionId}.jsonl`;
let sessionName = flag("--name");
const model = {
  id: "fake-1",
  name: "Fake 1",
  provider: "fake",
  api: "fake",
  reasoning: false,
  input: ["text"],
  contextWindow: 8000,
  maxTokens: 1000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

let streaming = false;
let aborted = false;
const messages = [];
const pendingUi = new Map();
const out = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
const respond = (cmd, command, extra = {}) =>
  out({
    type: "response",
    ...(cmd.id !== undefined ? { id: cmd.id } : {}),
    command,
    success: true,
    ...extra,
  });
const fail = (cmd, command, error) =>
  out({ type: "response", ...(cmd.id !== undefined ? { id: cmd.id } : {}), command, success: false, error });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function askUi(request) {
  return new Promise((resolve) => {
    pendingUi.set(request.id, resolve);
    out({ type: "extension_ui_request", ...request });
  });
}

async function runTurn(text) {
  streaming = true;
  aborted = false;
  const now = Date.now();
  const user = { role: "user", content: text, timestamp: now };
  messages.push(user);
  out({ type: "agent_start" });
  out({ type: "turn_start" });
  out({ type: "message_start", message: user });
  out({ type: "message_end", message: user });

  const assistant = {
    role: "assistant",
    content: [],
    api: "fake",
    provider: "fake",
    model: "fake-1",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
  out({ type: "message_start", message: assistant });

  let reply = `echo: ${text}`;
  if (text.includes("SPAWN_CHILD")) {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
      windowsHide: true,
    });
    out({ type: "fake_child", pid: child.pid });
    reply = `spawned ${child.pid}`;
  }
  if (text.includes("ASK")) {
    const answer = await askUi({
      id: `ui-${randomUUID()}`,
      method: "confirm",
      title: "Proceed?",
      message: text,
    });
    reply = `answered:${answer && "confirmed" in answer ? answer.confirmed : "cancelled"}`;
  }
  if (text.includes("CRASH")) {
    process.stderr.write("fake pi: simulated crash\n");
    process.exit(3);
  }
  if (text.includes("HANG")) {
    await new Promise(() => {});
  }
  const words = reply.split(" ");
  out({
    type: "message_update",
    usage: assistant.usage,
    assistantMessageEvent: { type: "text_start", contentIndex: 0 },
  });
  let acc = "";
  for (const w of words) {
    if (aborted) break;
    if (text.includes("SLOW")) await sleep(150);
    const delta = `${acc ? " " : ""}${w}`;
    acc += delta;
    out({
      type: "message_update",
      usage: assistant.usage,
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta },
    });
  }
  out({
    type: "message_update",
    usage: assistant.usage,
    assistantMessageEvent: { type: "text_end", contentIndex: 0, content: acc },
  });
  assistant.content = [{ type: "text", text: acc }];
  if (aborted) assistant.stopReason = "aborted";
  messages.push(assistant);
  out({ type: "message_end", message: assistant });
  out({ type: "turn_end", message: assistant, toolResults: [] });
  out({ type: "agent_end", messages: [user, assistant], willRetry: false });
  out({ type: "agent_settled" });
  streaming = false;
}

function handle(cmd) {
  switch (cmd.type) {
    case "get_state":
      return respond(cmd, "get_state", {
        data: {
          model,
          thinkingLevel: "off",
          isStreaming: streaming,
          isCompacting: false,
          steeringMode: "all",
          followUpMode: "one-at-a-time",
          sessionFile,
          sessionId,
          ...(sessionName ? { sessionName } : {}),
          autoCompactionEnabled: true,
          messageCount: messages.length,
          pendingMessageCount: 0,
        },
      });
    case "get_messages":
      return respond(cmd, "get_messages", { data: { messages } });
    case "get_entries":
      return respond(cmd, "get_entries", {
        data: {
          entries: messages.map((m, i) => ({
            type: "message",
            id: `e${i + 1}`,
            parentId: i ? `e${i}` : null,
            timestamp: new Date(m.timestamp).toISOString(),
            message: m,
          })),
          leafId: messages.length ? `e${messages.length}` : null,
        },
      });
    case "get_available_models":
      return respond(cmd, "get_available_models", { data: { models: [model] } });
    case "prompt":
      if (streaming && !cmd.streamingBehavior)
        return fail(cmd, "prompt", "Agent is streaming; specify streamingBehavior");
      respond(cmd, "prompt");
      void runTurn(String(cmd.message ?? ""));
      return;
    case "abort":
      aborted = true;
      return respond(cmd, "abort");
    case "set_model":
      return respond(cmd, "set_model", { data: model });
    case "set_thinking_level":
      return respond(cmd, "set_thinking_level");
    case "set_session_name":
      sessionName = String(cmd.name ?? "");
      return respond(cmd, "set_session_name");
    case "set_steering_mode":
    case "set_follow_up_mode":
    case "clear_queue":
    case "compact":
    case "steer":
    case "follow_up":
      return respond(cmd, cmd.type);
    case "get_tree":
      return respond(cmd, "get_tree", {
        data: { tree: messages.map((_m, i) => ({ id: `e${i + 1}`, children: [] })) },
      });
    case "fork":
      return respond(cmd, "fork", { data: { text: "forked", cancelled: false } });
    case "get_session_stats":
      return respond(cmd, "get_session_stats", {
        data: {
          sessionId,
          userMessages: messages.filter((m) => m.role === "user").length,
          assistantMessages: messages.filter((m) => m.role === "assistant").length,
          toolCalls: 0,
          toolResults: 0,
          totalMessages: messages.length,
          tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          cost: 0,
        },
      });
    case "extension_ui_response": {
      const r = pendingUi.get(cmd.id);
      if (r) {
        pendingUi.delete(cmd.id);
        r(cmd);
      }
      return;
    }
    default:
      return fail(cmd, String(cmd.type ?? "parse"), `unknown command: ${cmd.type}`);
  }
}

// The fake may use readline: its input is our own encoder, never untrusted bytes.
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let cmd;
  try {
    cmd = JSON.parse(line);
  } catch (err) {
    return out({
      type: "response",
      command: "parse",
      success: false,
      error: `Failed to parse command: ${err.message}`,
    });
  }
  handle(cmd);
});
rl.on("close", () => {
  if (ignoreStdinEnd) return; // keep the event loop alive: exercises the tree-kill fallback
  process.exit(0);
});
if (ignoreStdinEnd) setInterval(() => {}, 1000);
