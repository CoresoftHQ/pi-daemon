// The subset of pi's RPC-mode vocabulary the daemon uses (pi docs/rpc.md). Kept deliberately
// loose where pi's own types are richer than we need; `sessions` narrows what it consumes.

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface RpcModel {
  id: string;
  name?: string;
  provider: string;
  api?: string;
  reasoning?: boolean;
  input?: string[];
  contextWindow?: number;
  maxTokens?: number;
  cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
}

export interface RpcState {
  model: RpcModel | null;
  thinkingLevel: ThinkingLevel;
  isStreaming: boolean;
  isCompacting?: boolean;
  steeringMode?: "all" | "one-at-a-time";
  followUpMode?: "all" | "one-at-a-time";
  sessionFile?: string;
  sessionId: string;
  sessionName?: string;
  autoCompactionEnabled?: boolean;
  messageCount?: number;
  pendingMessageCount?: number;
}

export type RpcCommand =
  | { type: "get_state" }
  | { type: "get_messages" }
  | { type: "get_entries"; since?: string }
  | { type: "get_available_models" }
  | { type: "get_session_stats" }
  | { type: "get_tree" }
  | { type: "prompt"; message: string; images?: unknown[]; streamingBehavior?: "steer" | "followUp" }
  | { type: "steer"; message: string; images?: unknown[] }
  | { type: "follow_up"; message: string; images?: unknown[] }
  | { type: "abort" }
  | { type: "clear_queue" }
  | { type: "set_steering_mode"; mode: "all" | "one-at-a-time" }
  | { type: "set_follow_up_mode"; mode: "all" | "one-at-a-time" }
  | { type: "compact"; customInstructions?: string }
  | { type: "set_model"; provider: string; modelId: string }
  | { type: "set_thinking_level"; level: ThinkingLevel }
  | { type: "set_session_name"; name: string }
  | { type: "fork"; entryId: string }
  | { type: "switch_session"; sessionPath: string };

export type RpcCommandType = RpcCommand["type"];

export interface RpcResponse<T = unknown> {
  type: "response";
  id?: string;
  command: string;
  success: boolean;
  data?: T;
  error?: string;
}

/** Any event pi streams. Known shapes are documented; the index signature admits the rest. */
export interface RpcEvent {
  type: string;
  [key: string]: unknown;
}

export type UiMethod =
  | "select"
  | "confirm"
  | "input"
  | "editor"
  | "notify"
  | "setStatus"
  | "setWidget"
  | "setTitle"
  | "set_editor_text";

export interface ExtensionUiRequest {
  type: "extension_ui_request";
  id: string;
  method: UiMethod | string;
  title?: string;
  message?: string;
  options?: string[];
  placeholder?: string;
  timeout?: number;
  [key: string]: unknown;
}

export type ExtensionUiResponse = { value: string } | { confirmed: boolean } | { cancelled: true };

/** Methods that block pi until answered; the rest are fire-and-forget. */
export const BLOCKING_UI_METHODS: ReadonlySet<string> = new Set(["select", "confirm", "input", "editor"]);
