// Request and response bodies of /v1 (spec §5.1, §6, §10).

import type { Static } from "typebox";
import { Type } from "typebox";
import { ModelRef, SessionSnapshot, SessionSummary, ThinkingLevel } from "./session.ts";

export const ErrorBody = Type.Object({
  error: Type.Object(
    { code: Type.String(), message: Type.String() },
    { additionalProperties: true, description: "extra fields name the rule that refused, never a path" },
  ),
});
export type ErrorBody = Static<typeof ErrorBody>;

// ---- discovery

export const Health = Type.Object({ ok: Type.Literal(true), version: Type.String() });
export type Health = Static<typeof Health>;

export const Capabilities = Type.Object({
  daemon: Type.Object({
    id: Type.String(),
    name: Type.String(),
    version: Type.String(),
    platform: Type.String(),
    startedAt: Type.Integer(),
  }),
  api: Type.Object({ version: Type.Literal(1) }),
  piProtocol: Type.Object({ version: Type.Literal(1), maxFrameLength: Type.Integer() }),
  pi: Type.Object({
    version: Type.Union([Type.String(), Type.Null()]),
    supported: Type.String(),
    path: Type.Union([Type.String(), Type.Null()]),
  }),
  features: Type.Array(Type.String()),
  absent: Type.Array(Type.String()),
  limits: Type.Record(Type.String(), Type.Number()),
});
export type Capabilities = Static<typeof Capabilities>;

// ---- access

export const PairRedeemRequest = Type.Object({
  code: Type.String(),
  deviceName: Type.String(),
  platform: Type.String(),
});
export type PairRedeemRequest = Static<typeof PairRedeemRequest>;

export const Role = Type.Union([Type.Literal("owner"), Type.Literal("member")]);
export type Role = Static<typeof Role>;

export const PairRedeemResponse = Type.Object({
  daemonId: Type.String(),
  daemonName: Type.String(),
  deviceId: Type.String(),
  token: Type.String(),
  role: Role,
  capabilities: Capabilities,
});
export type PairRedeemResponse = Static<typeof PairRedeemResponse>;

export const ConnectTicketResponse = Type.Object({
  ticket: Type.String(),
  expiresAt: Type.Integer(),
  ttlMs: Type.Integer(),
});
export type ConnectTicketResponse = Static<typeof ConnectTicketResponse>;

export const Device = Type.Object({
  id: Type.String(),
  name: Type.String(),
  platform: Type.String(),
  role: Role,
  createdAt: Type.Integer(),
  lastSeenAt: Type.Optional(Type.Integer()),
  tailnetUser: Type.Optional(Type.String()),
});
export type Device = Static<typeof Device>;
export const DeviceList = Type.Object({ devices: Type.Array(Device) });
export const DevicePatch = Type.Object({ role: Type.Optional(Role), name: Type.Optional(Type.String()) });

// ---- sessions

export const SessionList = Type.Object({ sessions: Type.Array(SessionSummary) });
export type SessionList = Static<typeof SessionList>;

export const CreateSessionRequest = Type.Object({
  workspaceId: Type.String(),
  model: Type.Optional(ModelRef),
  thinkingLevel: Type.Optional(ThinkingLevel),
  name: Type.Optional(Type.String()),
});
export type CreateSessionRequest = Static<typeof CreateSessionRequest>;

export const SessionResponse = Type.Object({ session: SessionSnapshot });
export type SessionResponse = Static<typeof SessionResponse>;

export const PromptRequest = Type.Object({
  text: Type.String(),
  /** When a turn is running: queue as a steer or a follow-up instead of failing with busy. */
  during: Type.Optional(Type.Union([Type.Literal("steer"), Type.Literal("followUp")])),
});
export type PromptRequest = Static<typeof PromptRequest>;

/** `runId` is present when the prompt started a run; `queued` when it was queued behind one (spec §8). */
export const PromptResponse = Type.Object({
  runId: Type.Optional(Type.String()),
  queued: Type.Boolean(),
  revision: Type.Integer(),
});
export type PromptResponse = Static<typeof PromptResponse>;

export const TextRequest = Type.Object({ text: Type.String() });
export const QueueModeRequest = Type.Object({
  queue: Type.Union([Type.Literal("steering"), Type.Literal("followUp")]),
  mode: Type.Union([Type.Literal("all"), Type.Literal("one-at-a-time")]),
});
export const CompactRequest = Type.Object({ customInstructions: Type.Optional(Type.String()) });
export const SetModelRequest = Type.Object({ model: ModelRef });
export const SetThinkingRequest = Type.Object({ thinkingLevel: ThinkingLevel });
export const SetNameRequest = Type.Object({ name: Type.String() });
export const ForkRequest = Type.Object({ entryId: Type.String() });

export const EntriesResponse = Type.Object({
  entries: Type.Array(Type.Unknown(), {
    description: "pi session entries, verbatim; ids are durable cursors",
  }),
  leafId: Type.Union([Type.String(), Type.Null()]),
});
export const StatsResponse = Type.Object({ stats: Type.Unknown() });
export const TreeResponse = Type.Object({ tree: Type.Unknown() });

// ---- dialogs

/** One of pi's extension_ui_response shapes (spec §7.2). */
export const DialogRespondRequest = Type.Union([
  Type.Object({ value: Type.String() }),
  Type.Object({ confirmed: Type.Boolean() }),
  Type.Object({ cancelled: Type.Literal(true) }),
]);
export type DialogRespondRequest = Static<typeof DialogRespondRequest>;

export const DialogRespondResponse = Type.Object({ dialogId: Type.String(), resolution: Type.String() });
export const DialogConflict = Type.Object({
  error: Type.Object({
    code: Type.Literal("already_resolved"),
    message: Type.String(),
    resolution: Type.String(),
    answeredBy: Type.Optional(Type.String()),
  }),
});
