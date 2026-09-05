// Projects pi RPC events into canonical SessionState plus transient Progress (spec §5.3).
//
// Rules learned in M0 against pi's own reducers:
//   - snapshots are authoritative; progress is a hint the daemon never reduces itself
//   - a user item has no lifecycle: it is announced with item_started and becomes authoritative
//     through the next snapshot; item_finished admits only assistant and tool items
//   - finished items go into the transcript; in-flight ones live only in progress until then
//
// History loaded from `get_entries` keeps pi's durable entry ids. Items created live are
// minted `live:<n>`; they are unique within the session and stable for the runner's lifetime,
// and a rehydrate replaces them with durable ids through a fresh authoritative snapshot.

import type { RpcEvent, RpcModel, RpcState } from "../runners/rpc.ts";
import type {
  AssistantItem,
  ImageContent,
  ModelRef,
  Progress,
  SessionState,
  TextContent,
  ThinkingContent,
  ToolCallContent,
  ToolItem,
  TranscriptItem,
  Usage,
  UserItem,
} from "./state.ts";

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

type Loose = Record<string, unknown>;
const obj = (v: unknown): Loose => (v && typeof v === "object" ? (v as Loose) : {});
const str = (v: unknown, d = ""): string => (typeof v === "string" ? v : d);
const num = (v: unknown, d = 0): number => (typeof v === "number" && Number.isFinite(v) ? v : d);

export function usageOf(u: unknown): Usage | undefined {
  if (!u || typeof u !== "object") return undefined;
  const o = obj(u);
  const cost = obj(o.cost);
  const input = num(o.input);
  const output = num(o.output);
  const cacheRead = num(o.cacheRead);
  const cacheWrite = num(o.cacheWrite);
  const out: Usage = {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: num(o.totalTokens, input + output + cacheRead + cacheWrite),
    cost: {
      input: num(cost.input),
      output: num(cost.output),
      cacheRead: num(cost.cacheRead),
      cacheWrite: num(cost.cacheWrite),
      total: num(cost.total),
    },
  };
  if (typeof o.reasoning === "number") out.reasoning = o.reasoning;
  return out;
}

function userContent(content: unknown): Array<TextContent | ImageContent> {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) return [];
  return content.map((b) => {
    const o = obj(b);
    return o.type === "image"
      ? { type: "image", data: str(o.data), mimeType: str(o.mimeType) }
      : { type: "text", text: str(o.text) };
  });
}

function assistantContent(content: unknown): Array<TextContent | ThinkingContent | ToolCallContent> {
  if (!Array.isArray(content)) return [];
  return content.map((b) => {
    const o = obj(b);
    if (o.type === "toolCall")
      return { type: "toolCall", toolCallId: str(o.id), toolName: str(o.name), input: o.arguments ?? {} };
    if (o.type === "thinking")
      return o.redacted
        ? { type: "thinking", thinking: str(o.thinking), redacted: true }
        : { type: "thinking", thinking: str(o.thinking) };
    return { type: "text", text: str(o.text) };
  });
}

function toolContent(content: unknown): Array<TextContent | ImageContent> {
  return userContent(content);
}

export function modelRef(m: RpcModel | null | undefined | Loose): ModelRef {
  const o = obj(m);
  return { provider: str(o.provider, "unknown"), id: str(o.id, "unknown") };
}

export interface ProjectorOutput {
  progress: Progress[];
  /** True when the authoritative state changed and a snapshot should be published. */
  snapshot: boolean;
  /** Set on agent_start with the run this turn belongs to. */
  runStarted?: string;
  /** Set on agent_settled. */
  runSettled?: string;
}

export interface ProjectorOptions {
  sessionId: string;
  workspaceId: string;
  cwd: string;
  createdAt?: number | undefined;
  mintRunId: () => string;
  now?: (() => number) | undefined;
}

export class Projector {
  readonly state: SessionState;
  readonly #now: () => number;
  readonly #mintRunId: () => string;
  #liveSeq = 0;
  #streaming = new Map<string, TranscriptItem>();
  #currentAssistant: string | null = null;
  #toolInputs = new Map<string, unknown>();
  #toolItemIds = new Map<string, string>();

  constructor(options: ProjectorOptions) {
    this.#now = options.now ?? Date.now;
    this.#mintRunId = options.mintRunId;
    const now = this.#now();
    this.state = {
      id: options.sessionId,
      workspaceId: options.workspaceId,
      cwd: options.cwd,
      createdAt: options.createdAt ?? now,
      updatedAt: now,
      phase: "idle",
      model: { provider: "unknown", id: "unknown" },
      thinkingLevel: "off",
      revision: 0,
      transcript: [],
      queuedSteer: [],
      queuedSteerCount: 0,
      live: false,
      attachedCount: 0,
    };
  }

  #mint(prefix: string): string {
    return `live:${prefix}${++this.#liveSeq}`;
  }

  bump(): void {
    this.state.revision += 1;
    this.state.updatedAt = this.#now();
  }

  /** Apply get_state: model, thinking level, name. */
  applyState(rpc: RpcState): void {
    this.state.model = modelRef(rpc.model);
    if (THINKING_LEVELS.has(rpc.thinkingLevel)) this.state.thinkingLevel = rpc.thinkingLevel;
    if (rpc.sessionName) this.state.name = rpc.sessionName;
    else delete this.state.name;
    this.bump();
  }

  setLive(live: boolean): void {
    if (this.state.live !== live) {
      this.state.live = live;
      this.bump();
    }
  }

  setAttachedCount(n: number): void {
    if (this.state.attachedCount !== n) {
      this.state.attachedCount = n;
      this.bump();
    }
  }

  /**
   * Load history from get_entries. Entries carry pi's durable ids; only message entries are
   * projected (compaction and other entry types are not part of the transcript view).
   */
  loadEntries(entries: unknown[]): void {
    const transcript: TranscriptItem[] = [];
    for (const raw of entries) {
      const e = obj(raw);
      if (e.type !== "message") continue;
      const id = str(e.id) || this.#mint("h");
      const item = this.#fromMessage(id, e.message, num(Date.parse(str(e.timestamp)), this.#now()));
      if (item) transcript.push(item);
    }
    this.state.transcript = transcript;
    this.#streaming.clear();
    this.#currentAssistant = null;
    this.bump();
  }

  /** Load history from get_messages when entries are unavailable. Ids are minted. */
  loadMessages(messages: unknown[]): void {
    const transcript: TranscriptItem[] = [];
    for (const raw of messages) {
      const m = obj(raw);
      const item = this.#fromMessage(this.#mint("h"), m, num(m.timestamp, this.#now()));
      if (item) transcript.push(item);
    }
    this.state.transcript = transcript;
    this.bump();
  }

  #fromMessage(id: string, raw: unknown, timestamp: number): TranscriptItem | null {
    const m = obj(raw);
    switch (m.role) {
      case "user":
        return { id, role: "user", content: userContent(m.content), timestamp: num(m.timestamp, timestamp) };
      case "assistant": {
        for (const b of Array.isArray(m.content) ? m.content : []) {
          const o = obj(b);
          if (o.type === "toolCall") this.#toolInputs.set(str(o.id), o.arguments ?? {});
        }
        return this.#finishedAssistant(id, m, num(m.timestamp, timestamp));
      }
      case "toolResult": {
        const toolCallId = str(m.toolCallId);
        const usage = usageOf(m.usage);
        return {
          id,
          role: "tool",
          toolCallId,
          toolName: str(m.toolName),
          input: this.#toolInputs.get(toolCallId) ?? {},
          content: toolContent(m.content),
          ...(m.details !== undefined ? { details: m.details } : {}),
          ...(usage ? { usage } : {}),
          timestamp: num(m.timestamp, timestamp),
          status: m.isError ? "error" : "complete",
          isError: !!m.isError,
        };
      }
      default:
        return null; // bashExecution, custom, …: not part of the transcript view
    }
  }

  #finishedAssistant(id: string, m: Loose, timestamp: number): AssistantItem {
    const usage = usageOf(m.usage);
    const base: AssistantItem = {
      id,
      role: "assistant",
      content: assistantContent(m.content),
      model: { provider: str(m.provider, this.state.model.provider), id: str(m.model, this.state.model.id) },
      ...(usage ? { usage } : {}),
      timestamp,
      status: "complete",
      stopReason: "stop",
    };
    const err = typeof m.errorMessage === "string" ? { errorMessage: m.errorMessage } : {};
    switch (m.stopReason) {
      case "error":
        return { ...base, status: "error", stopReason: "error", ...err };
      case "aborted":
        return { ...base, status: "aborted", stopReason: "aborted", ...err };
      case "length":
        return { ...base, stopReason: "length" };
      case "toolUse":
        return { ...base, stopReason: "toolUse" };
      default:
        return base;
    }
  }

  /** Apply one RPC event. */
  apply(ev: RpcEvent): ProjectorOutput {
    const out: ProjectorOutput = { progress: [], snapshot: false };
    const progress = (p: Progress) => out.progress.push(p);
    const snap = () => {
      this.bump();
      out.snapshot = true;
    };

    switch (ev.type) {
      case "agent_start": {
        const runId = this.#mintRunId();
        this.state.runId = runId;
        this.state.phase = "turn";
        delete this.state.interrupted;
        out.runStarted = runId;
        snap();
        break;
      }
      case "agent_settled":
        this.state.phase = "idle";
        this.#abandonStreaming();
        out.runSettled = this.state.runId ?? "";
        snap();
        break;
      case "compaction_start":
        this.state.phase = "compaction";
        snap();
        break;
      case "compaction_end":
        this.state.phase = "turn";
        snap();
        break;
      case "auto_retry_start":
        this.state.phase = "retry";
        snap();
        break;
      case "auto_retry_end":
        this.state.phase = "turn";
        snap();
        break;
      case "queue_update": {
        const steering = Array.isArray(ev.steering) ? (ev.steering as unknown[]) : [];
        this.state.queuedSteer = steering.map((s) => ({
          id: this.#mint("q"),
          role: "user" as const,
          content: userContent(s),
          timestamp: this.#now(),
        }));
        this.state.queuedSteerCount = steering.length;
        snap();
        break;
      }

      case "message_start": {
        const m = obj(ev.message);
        if (m.role === "user") {
          const item: UserItem = {
            id: this.#mint("u"),
            role: "user",
            content: userContent(m.content),
            timestamp: num(m.timestamp, this.#now()),
          };
          this.#streaming.set(item.id, item);
          progress({ type: "item_started", item });
        } else if (m.role === "assistant") {
          const item: AssistantItem = {
            id: this.#mint("a"),
            role: "assistant",
            content: assistantContent(m.content),
            model: {
              provider: str(m.provider, this.state.model.provider),
              id: str(m.model, this.state.model.id),
            },
            timestamp: num(m.timestamp, this.#now()),
            status: "streaming",
          };
          this.#streaming.set(item.id, item);
          this.#currentAssistant = item.id;
          progress({ type: "item_started", item });
        }
        break;
      }

      case "message_update": {
        const id = this.#currentAssistant;
        const item = id ? (this.#streaming.get(id) as AssistantItem | undefined) : undefined;
        const e = obj(ev.assistantMessageEvent);
        if (!item || !id || typeof e.type !== "string") break;
        const idx = num(e.contentIndex, item.content.length);
        const ensure = <T extends AssistantItem["content"][number]>(make: () => T): T => {
          while (item.content.length <= idx) item.content.push(make());
          return item.content[idx] as T;
        };
        const updated = () => progress({ type: "item_updated", item: structuredClone(item) });
        switch (e.type) {
          case "text_start":
            ensure(() => ({ type: "text", text: "" }));
            updated();
            break;
          case "text_delta": {
            const b = ensure(() => ({ type: "text", text: "" }));
            if (b.type === "text") b.text += str(e.delta);
            progress({
              type: "assistant_delta",
              messageId: id,
              contentIndex: idx,
              kind: "text",
              delta: str(e.delta),
            });
            break;
          }
          case "text_end": {
            const b = ensure(() => ({ type: "text", text: "" }));
            if (b.type === "text" && typeof e.content === "string") b.text = e.content;
            updated();
            break;
          }
          case "thinking_start":
            ensure(() => ({ type: "thinking", thinking: "" }));
            updated();
            break;
          case "thinking_delta": {
            const b = ensure(() => ({ type: "thinking", thinking: "" }));
            if (b.type === "thinking") b.thinking += str(e.delta);
            progress({
              type: "assistant_delta",
              messageId: id,
              contentIndex: idx,
              kind: "thinking",
              delta: str(e.delta),
            });
            break;
          }
          case "thinking_end": {
            const b = ensure(() => ({ type: "thinking", thinking: "" }));
            if (b.type === "thinking" && typeof e.content === "string") b.thinking = e.content;
            updated();
            break;
          }
          case "toolcall_start":
            ensure(() => ({ type: "toolCall", toolCallId: str(e.id), toolName: str(e.toolName), input: {} }));
            updated();
            break;
          case "toolcall_delta":
            progress({
              type: "assistant_delta",
              messageId: id,
              contentIndex: idx,
              kind: "toolCall",
              delta: str(e.delta),
            });
            break;
          case "toolcall_end": {
            const tc = obj(e.toolCall);
            const b = ensure(() => ({
              type: "toolCall",
              toolCallId: str(tc.id),
              toolName: str(tc.name),
              input: {},
            }));
            if (b.type === "toolCall" && Object.keys(tc).length) {
              b.toolCallId = str(tc.id);
              b.toolName = str(tc.name);
              b.input = tc.arguments ?? {};
              this.#toolInputs.set(b.toolCallId, b.input);
            }
            updated();
            break;
          }
          default:
            break;
        }
        break;
      }

      case "message_end": {
        const m = obj(ev.message);
        if (m.role === "user") {
          const id = [...this.#streaming.keys()].reverse().find((k) => k.startsWith("live:u"));
          if (id) {
            const item = this.#streaming.get(id) as UserItem;
            this.#streaming.delete(id);
            item.content = userContent(m.content);
            this.state.transcript.push(item);
            snap();
          }
        } else if (m.role === "assistant") {
          const id = this.#currentAssistant;
          if (id && this.#streaming.has(id)) {
            const live = this.#streaming.get(id) as AssistantItem;
            this.#streaming.delete(id);
            this.#currentAssistant = null;
            for (const b of Array.isArray(m.content) ? m.content : []) {
              const o = obj(b);
              if (o.type === "toolCall") this.#toolInputs.set(str(o.id), o.arguments ?? {});
            }
            const item = this.#finishedAssistant(id, m, live.timestamp);
            this.state.transcript.push(item);
            progress({ type: "item_finished", item });
            snap();
          }
        }
        break;
      }

      case "tool_execution_start": {
        const toolCallId = str(ev.toolCallId);
        const item: ToolItem = {
          id: this.#mint("t"),
          role: "tool",
          toolCallId,
          toolName: str(ev.toolName),
          input: ev.args ?? this.#toolInputs.get(toolCallId) ?? {},
          content: [],
          timestamp: this.#now(),
          status: "running",
          isError: false,
        };
        this.#toolItemIds.set(toolCallId, item.id);
        this.#streaming.set(item.id, item);
        progress({ type: "item_started", item });
        break;
      }
      case "tool_execution_update": {
        const id = this.#toolItemIds.get(str(ev.toolCallId));
        const item = id ? (this.#streaming.get(id) as ToolItem | undefined) : undefined;
        if (!item) break;
        item.content = toolContent(obj(ev.partialResult).content);
        progress({ type: "item_updated", item: structuredClone(item) });
        break;
      }
      case "tool_execution_end": {
        const toolCallId = str(ev.toolCallId);
        const id = this.#toolItemIds.get(toolCallId);
        const live = id ? (this.#streaming.get(id) as ToolItem | undefined) : undefined;
        if (!live || !id) break;
        this.#streaming.delete(id);
        const result = obj(ev.result);
        const item: ToolItem = {
          id,
          role: "tool",
          toolCallId,
          toolName: str(ev.toolName, live.toolName),
          input: live.input,
          content: toolContent(result.content),
          ...(result.details !== undefined ? { details: result.details } : {}),
          timestamp: live.timestamp,
          status: ev.isError ? "error" : "complete",
          isError: !!ev.isError,
        };
        this.state.transcript.push(item);
        progress({ type: "item_finished", item });
        snap();
        break;
      }
      default:
        break;
    }
    return out;
  }

  /** A turn ended without finishing its streaming items (abort mid-stream, crash): drop them. */
  #abandonStreaming(): void {
    this.#streaming.clear();
    this.#currentAssistant = null;
  }

  /** Mark the current run as interrupted (runner died mid-turn). */
  markInterrupted(reason: NonNullable<SessionState["interrupted"]>["reason"], detail?: string): void {
    if (this.state.phase !== "idle" || this.#streaming.size > 0) {
      this.state.interrupted = {
        runId: this.state.runId ?? "",
        at: this.#now(),
        reason,
        ...(detail ? { detail } : {}),
      };
    }
    this.state.phase = "idle";
    this.#abandonStreaming();
    this.bump();
  }
}
