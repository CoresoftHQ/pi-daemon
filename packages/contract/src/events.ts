// The event stream (spec §5.2): one envelope, one global monotonic `seq`, scopes for filtering.
// Gaps in `seq` on a filtered stream are normal and are not loss.

import type { Static } from "typebox";
import { Type } from "typebox";
import { Interrupted, ModelRef, Phase, Progress, ThinkingLevel } from "./session.ts";

export const Scope = Type.String({
  description: "daemon | workspace:<id> | session:<id> | terminal:<id>",
  pattern: "^(daemon|workspace:.+|session:.+|terminal:.+)$",
});
export type Scope = Static<typeof Scope>;

export const EventEnvelope = Type.Object({
  seq: Type.Integer({ minimum: 1 }),
  scope: Scope,
  type: Type.String(),
  at: Type.Integer(),
  payload: Type.Unknown(),
});
export type EventEnvelope = Static<typeof EventEnvelope>;

/** Sent instead of a replay when `since` predates the ring: re-read state, resume from `watermark`. */
export const SnapshotRequired = Type.Object({ watermark: Type.Integer(), oldest: Type.Integer() });

export const SessionCreated = Type.Object({ sessionId: Type.String(), workspaceId: Type.String() });
export const SessionPhase = Type.Object({ sessionId: Type.String(), phase: Phase, runId: Type.String() });
export const SessionChanged = Type.Object({
  sessionId: Type.String(),
  revision: Type.Integer(),
  phase: Phase,
  live: Type.Boolean(),
  runId: Type.Optional(Type.String()),
  name: Type.Optional(Type.String()),
  model: ModelRef,
  thinkingLevel: ThinkingLevel,
  transcriptLength: Type.Integer(),
  attachedCount: Type.Integer(),
});
export const SessionInterrupted = Type.Intersect([Type.Object({ sessionId: Type.String() }), Interrupted]);
export const SessionEvicted = Type.Object({ sessionId: Type.String(), reason: Type.String() });
export const RunnerFailed = Type.Object({
  sessionId: Type.String(),
  code: Type.Union([Type.Integer(), Type.Null()]),
  signal: Type.Union([Type.String(), Type.Null()]),
  stderrTail: Type.String(),
});
export const TranscriptProgress = Progress;

/** A relayed extension_ui_request. `request` is pi's object, verbatim (spec §7.2). */
export const DialogOpened = Type.Object({
  dialogId: Type.String(),
  sessionId: Type.String(),
  request: Type.Object(
    { id: Type.String(), method: Type.String() },
    { additionalProperties: true, description: "pi's extension_ui_request, verbatim" },
  ),
});
export const DialogClosed = Type.Object({
  dialogId: Type.String(),
  sessionId: Type.String(),
  resolution: Type.Union([
    Type.Literal("answered"),
    Type.Literal("cancelled"),
    Type.Literal("runner_exited"),
    Type.Literal("superseded"),
  ]),
  answeredBy: Type.Optional(Type.String()),
});
export const Notice = Type.Object({
  sessionId: Type.String(),
  request: Type.Object({ id: Type.String(), method: Type.String() }, { additionalProperties: true }),
});
export const DevicePaired = Type.Object({
  deviceId: Type.String(),
  name: Type.String(),
  role: Type.String(),
});
export const DeviceRevoked = Type.Object({ deviceId: Type.String() });
export const DaemonShutdown = Type.Object({ reason: Type.String() });

/** Event type → payload schema. The envelope's `payload` is one of these by `type`. */
export const EventPayloads = {
  "snapshot.required": SnapshotRequired,
  "session.created": SessionCreated,
  "session.phase": SessionPhase,
  "session.changed": SessionChanged,
  "session.interrupted": SessionInterrupted,
  "session.evicted": SessionEvicted,
  "runner.failed": RunnerFailed,
  "transcript.item_started": TranscriptProgress,
  "transcript.item_updated": TranscriptProgress,
  "transcript.item_finished": TranscriptProgress,
  "transcript.assistant_delta": TranscriptProgress,
  "dialog.opened": DialogOpened,
  "dialog.closed": DialogClosed,
  notice: Notice,
  "device.paired": DevicePaired,
  "device.revoked": DeviceRevoked,
  "daemon.shutdown": DaemonShutdown,
} as const;
export type EventType = keyof typeof EventPayloads;

/** Client → server on the event WebSocket: change subscriptions without reconnecting. */
export const EventStreamControl = Type.Union([
  Type.Object({ type: Type.Literal("subscribe"), scopes: Type.Array(Scope) }),
  Type.Object({ type: Type.Literal("unsubscribe"), scopes: Type.Array(Scope) }),
  Type.Object({ type: Type.Literal("ping") }),
]);
export type EventStreamControl = Static<typeof EventStreamControl>;
