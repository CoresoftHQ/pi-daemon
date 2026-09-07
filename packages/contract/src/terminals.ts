// Terminals (spec §5.5): an ordinary shell in a workspace. Bytes travel on a dedicated binary
// WebSocket, not on the event stream; these are the JSON shapes around it.

import type { Static } from "typebox";
import { Type } from "typebox";

export const TerminalExit = Type.Object({
  code: Type.Union([Type.Integer(), Type.Null()]),
  signal: Type.Union([Type.Integer(), Type.Null()]),
  reason: Type.Union([
    Type.Literal("exited"),
    Type.Literal("closed"),
    Type.Literal("shutdown"),
    Type.Literal("failed"),
  ]),
  at: Type.Integer(),
});

export const TerminalInfo = Type.Object({
  id: Type.String(),
  workspaceId: Type.String(),
  pid: Type.Integer(),
  cols: Type.Integer(),
  rows: Type.Integer(),
  /** The title the program last set (OSC 0/2), or "". */
  title: Type.String(),
  command: Type.String(),
  status: Type.Union([Type.Literal("running"), Type.Literal("exited")]),
  createdAt: Type.Integer(),
  attachedCount: Type.Integer(),
  exit: Type.Optional(TerminalExit),
});
export type TerminalInfo = Static<typeof TerminalInfo>;

export const TerminalList = Type.Object({ terminals: Type.Array(TerminalInfo) });
export const TerminalResponse = Type.Object({ terminal: TerminalInfo });

export const CreateTerminalRequest = Type.Object({
  cols: Type.Integer({ minimum: 2, maximum: 500 }),
  rows: Type.Integer({ minimum: 1, maximum: 300 }),
  /** Run this instead of the shell. An array, never a string. */
  argv: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 64 })),
});
export type CreateTerminalRequest = Static<typeof CreateTerminalRequest>;

export const ResizeTerminalRequest = Type.Object({
  cols: Type.Integer({ minimum: 2, maximum: 500 }),
  rows: Type.Integer({ minimum: 1, maximum: 300 }),
});

/** Text frames on `/v1/terminals/:id/stream`, client → server. Binary frames are PTY input. */
export const TerminalClientControl = Type.Union([
  Type.Object({
    type: Type.Literal("resize"),
    cols: Type.Integer({ minimum: 2, maximum: 500 }),
    rows: Type.Integer({ minimum: 1, maximum: 300 }),
  }),
  Type.Object({ type: Type.Literal("ping") }),
]);
export type TerminalClientControl = Static<typeof TerminalClientControl>;

/** Text frames, server → client. Binary frames are PTY output. */
export const TerminalServerControl = Type.Union([
  /** First frame on attach: the screen and scrollback as VT sequences to replay. */
  Type.Object({
    type: Type.Literal("snapshot"),
    cols: Type.Integer(),
    rows: Type.Integer(),
    title: Type.String(),
    data: Type.String(),
  }),
  Type.Object({ type: Type.Literal("resize"), cols: Type.Integer(), rows: Type.Integer() }),
  Type.Object({ type: Type.Literal("title"), title: Type.String() }),
  Type.Object({ type: Type.Literal("exit"), exit: TerminalExit }),
  Type.Object({ type: Type.Literal("pong") }),
]);
export type TerminalServerControl = Static<typeof TerminalServerControl>;

// ---- events

export const TerminalCreated = Type.Object({ terminal: TerminalInfo });
export const TerminalExited = Type.Intersect([
  Type.Object({ terminalId: Type.String(), workspaceId: Type.String() }),
  TerminalExit,
]);
export const TerminalTitle = Type.Object({ terminalId: Type.String(), title: Type.String() });
