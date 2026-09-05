// Canonical session state (spec §5.3): one producer, two encoders. These shapes are ours and
// deliberately a superset of pi-protocol's SessionSnapshot, which `serve` maps onto without
// importing anything from pi here (boundary rule: only runners and serve know pi exists).
//
// Assistant and tool items are discriminated unions exactly as pi's schemas are — a streaming
// assistant item has no stopReason, a running tool item has isError false — so that the
// encoder's structural pin against pi's types is a real check rather than a cast.

export type Phase = "idle" | "turn" | "compaction" | "branch_summary" | "retry";
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface ModelRef {
  provider: string;
  id: string;
}

export interface TextContent {
  type: "text";
  text: string;
}
export interface ImageContent {
  type: "image";
  data: string;
  mimeType: string;
}
export interface ThinkingContent {
  type: "thinking";
  thinking: string;
  redacted?: boolean;
}
export interface ToolCallContent {
  type: "toolCall";
  toolCallId: string;
  toolName: string;
  input: unknown;
}

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning?: number;
  totalTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}

export interface UserItem {
  id: string;
  role: "user";
  content: Array<TextContent | ImageContent>;
  timestamp: number;
}

interface AssistantBase {
  id: string;
  role: "assistant";
  content: Array<TextContent | ThinkingContent | ToolCallContent>;
  model: ModelRef;
  responseModel?: string;
  usage?: Usage;
  timestamp: number;
}
export interface StreamingAssistantItem extends AssistantBase {
  status: "streaming";
}
export interface CompleteAssistantItem extends AssistantBase {
  status: "complete";
  stopReason: "stop" | "length" | "toolUse";
}
export interface ErrorAssistantItem extends AssistantBase {
  status: "error";
  stopReason: "error";
  errorMessage?: string;
}
export interface AbortedAssistantItem extends AssistantBase {
  status: "aborted";
  stopReason: "aborted";
  errorMessage?: string;
}
export type AssistantItem =
  | StreamingAssistantItem
  | CompleteAssistantItem
  | ErrorAssistantItem
  | AbortedAssistantItem;
export type AssistantStatus = AssistantItem["status"];

interface ToolBase {
  id: string;
  role: "tool";
  toolCallId: string;
  toolName: string;
  input: unknown;
  content: Array<TextContent | ImageContent>;
  details?: unknown;
  usage?: Usage;
  timestamp: number;
}
export interface RunningToolItem extends ToolBase {
  status: "running";
  isError: false;
}
export interface CompleteToolItem extends ToolBase {
  status: "complete";
  isError: false;
}
export interface ErrorToolItem extends ToolBase {
  status: "error";
  isError: true;
}
export type ToolItem = RunningToolItem | CompleteToolItem | ErrorToolItem;
export type ToolStatus = ToolItem["status"];

export type TranscriptItem = UserItem | AssistantItem | ToolItem;

/** What item_finished may carry: pi's schema admits neither a streaming assistant nor a running tool. */
export type FinishedAssistantItem = Exclude<AssistantItem, StreamingAssistantItem>;
export type FinishedToolItem = Exclude<ToolItem, RunningToolItem>;
export type FinishedItem = FinishedAssistantItem | FinishedToolItem;

/** Transient streaming hints (spec §4.2). Never reduced into authoritative state by the daemon. */
export type Progress =
  | { type: "item_started"; item: TranscriptItem }
  | { type: "item_updated"; item: AssistantItem | ToolItem }
  | { type: "item_finished"; item: FinishedItem }
  | {
      type: "assistant_delta";
      messageId: string;
      contentIndex: number;
      kind: "text" | "thinking" | "toolCall";
      delta: string;
    };

export interface Interrupted {
  runId: string;
  at: number;
  reason: "runner_crashed" | "daemon_restart" | "evicted_mid_turn";
  detail?: string;
}

/** The authoritative state of one session. `revision` increases on every change. */
export interface SessionState {
  id: string;
  workspaceId: string;
  cwd: string;
  name?: string;
  createdAt: number;
  updatedAt: number;
  phase: Phase;
  model: ModelRef;
  thinkingLevel: ThinkingLevel;
  revision: number;
  transcript: TranscriptItem[];
  queuedSteer: UserItem[];
  queuedSteerCount: number;
  /** The daemon-minted id of the current or most recent run (spec §8). */
  runId?: string;
  /** Set when a turn died with the runner; cleared by the next successful prompt. */
  interrupted?: Interrupted;
  /** Whether a runner process currently backs this session. */
  live: boolean;
  /** Number of connections holding a lease. */
  attachedCount: number;
}

export function cloneState(s: SessionState): SessionState {
  return structuredClone(s);
}
