// Session shapes on the JSON surface (spec §5). These mirror the daemon's canonical state and
// pi-protocol's transcript items deliberately: the same information in a second encoding, so
// a client that speaks only JSON is complete (spec §5.3).

import type { Static } from "typebox";
import { Type } from "typebox";

export const Phase = Type.Union([
  Type.Literal("idle"),
  Type.Literal("turn"),
  Type.Literal("compaction"),
  Type.Literal("branch_summary"),
  Type.Literal("retry"),
]);
export type Phase = Static<typeof Phase>;

export const ThinkingLevel = Type.Union([
  Type.Literal("off"),
  Type.Literal("minimal"),
  Type.Literal("low"),
  Type.Literal("medium"),
  Type.Literal("high"),
  Type.Literal("xhigh"),
  Type.Literal("max"),
]);
export type ThinkingLevel = Static<typeof ThinkingLevel>;

export const ModelRef = Type.Object({ provider: Type.String(), id: Type.String() });
export type ModelRef = Static<typeof ModelRef>;

export const TextContent = Type.Object({ type: Type.Literal("text"), text: Type.String() });
export const ImageContent = Type.Object({
  type: Type.Literal("image"),
  data: Type.String(),
  mimeType: Type.String(),
});
export const ThinkingContent = Type.Object({
  type: Type.Literal("thinking"),
  thinking: Type.String(),
  redacted: Type.Optional(Type.Boolean()),
});
export const ToolCallContent = Type.Object({
  type: Type.Literal("toolCall"),
  toolCallId: Type.String(),
  toolName: Type.String(),
  input: Type.Unknown(),
});

export const Usage = Type.Object({
  input: Type.Integer(),
  output: Type.Integer(),
  cacheRead: Type.Integer(),
  cacheWrite: Type.Integer(),
  reasoning: Type.Optional(Type.Integer()),
  totalTokens: Type.Integer(),
  cost: Type.Object({
    input: Type.Number(),
    output: Type.Number(),
    cacheRead: Type.Number(),
    cacheWrite: Type.Number(),
    total: Type.Number(),
  }),
});
export type Usage = Static<typeof Usage>;

export const UserItem = Type.Object({
  id: Type.String(),
  role: Type.Literal("user"),
  content: Type.Array(Type.Union([TextContent, ImageContent])),
  timestamp: Type.Integer(),
});
export type UserItem = Static<typeof UserItem>;

const assistantBase = {
  id: Type.String(),
  role: Type.Literal("assistant"),
  content: Type.Array(Type.Union([TextContent, ThinkingContent, ToolCallContent])),
  model: ModelRef,
  responseModel: Type.Optional(Type.String()),
  usage: Type.Optional(Usage),
  timestamp: Type.Integer(),
};
export const AssistantItem = Type.Union([
  Type.Object({ ...assistantBase, status: Type.Literal("streaming") }),
  Type.Object({
    ...assistantBase,
    status: Type.Literal("complete"),
    stopReason: Type.Union([Type.Literal("stop"), Type.Literal("length"), Type.Literal("toolUse")]),
  }),
  Type.Object({
    ...assistantBase,
    status: Type.Literal("error"),
    stopReason: Type.Literal("error"),
    errorMessage: Type.Optional(Type.String()),
  }),
  Type.Object({
    ...assistantBase,
    status: Type.Literal("aborted"),
    stopReason: Type.Literal("aborted"),
    errorMessage: Type.Optional(Type.String()),
  }),
]);
export type AssistantItem = Static<typeof AssistantItem>;

const toolBase = {
  id: Type.String(),
  role: Type.Literal("tool"),
  toolCallId: Type.String(),
  toolName: Type.String(),
  input: Type.Unknown(),
  content: Type.Array(Type.Union([TextContent, ImageContent])),
  details: Type.Optional(Type.Unknown()),
  usage: Type.Optional(Usage),
  timestamp: Type.Integer(),
};
export const ToolItem = Type.Union([
  Type.Object({ ...toolBase, status: Type.Literal("running"), isError: Type.Literal(false) }),
  Type.Object({ ...toolBase, status: Type.Literal("complete"), isError: Type.Literal(false) }),
  Type.Object({ ...toolBase, status: Type.Literal("error"), isError: Type.Literal(true) }),
]);
export type ToolItem = Static<typeof ToolItem>;

export const TranscriptItem = Type.Union([UserItem, AssistantItem, ToolItem]);
export type TranscriptItem = Static<typeof TranscriptItem>;

/** Transient streaming hints. Never authoritative; a snapshot always confirms or supersedes. */
export const Progress = Type.Union([
  Type.Object({ type: Type.Literal("item_started"), item: TranscriptItem }),
  Type.Object({ type: Type.Literal("item_updated"), item: Type.Union([AssistantItem, ToolItem]) }),
  Type.Object({ type: Type.Literal("item_finished"), item: Type.Union([AssistantItem, ToolItem]) }),
  Type.Object({
    type: Type.Literal("assistant_delta"),
    messageId: Type.String(),
    contentIndex: Type.Integer(),
    kind: Type.Union([Type.Literal("text"), Type.Literal("thinking"), Type.Literal("toolCall")]),
    delta: Type.String(),
  }),
]);
export type Progress = Static<typeof Progress>;

export const Interrupted = Type.Object({
  runId: Type.String(),
  at: Type.Integer(),
  reason: Type.Union([
    Type.Literal("runner_crashed"),
    Type.Literal("daemon_restart"),
    Type.Literal("evicted_mid_turn"),
  ]),
  detail: Type.Optional(Type.String()),
});
export type Interrupted = Static<typeof Interrupted>;

/** The authoritative session snapshot, JSON encoding. `revision` matches the CBOR encoding's. */
export const SessionSnapshot = Type.Object({
  id: Type.String(),
  workspaceId: Type.String(),
  name: Type.Optional(Type.String()),
  createdAt: Type.Integer(),
  updatedAt: Type.Integer(),
  phase: Phase,
  model: ModelRef,
  thinkingLevel: ThinkingLevel,
  revision: Type.Integer(),
  transcript: Type.Array(TranscriptItem),
  queuedSteer: Type.Array(UserItem),
  queuedSteerCount: Type.Integer(),
  runId: Type.Optional(Type.String()),
  interrupted: Type.Optional(Interrupted),
  live: Type.Boolean(),
  attachedCount: Type.Integer(),
});
export type SessionSnapshot = Static<typeof SessionSnapshot>;

/** The listing shape: everything the daemon knows about a session without opening it. */
export const SessionSummary = Type.Object({
  id: Type.String(),
  workspaceId: Type.Optional(Type.String()),
  name: Type.Optional(Type.String()),
  createdAt: Type.Integer(),
  updatedAt: Type.Integer(),
  live: Type.Boolean(),
  phase: Type.Optional(Phase),
  runId: Type.Optional(Type.String()),
  interrupted: Type.Optional(Interrupted),
  attachedCount: Type.Integer(),
});
export type SessionSummary = Static<typeof SessionSummary>;
