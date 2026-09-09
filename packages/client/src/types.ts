// Every wire shape, derived from the contract's schemas so the client and the daemon cannot
// disagree. Type-only: the contract package is not needed at runtime.

import type * as C from "@coresoft-hq/pi-daemon-contract";
import type { Static } from "typebox";

export type Capabilities = Static<typeof C.Capabilities>;
export type Health = Static<typeof C.Health>;
export type PairRedeemRequest = Static<typeof C.PairRedeemRequest>;
export type PairRedeemResponse = Static<typeof C.PairRedeemResponse>;
export type ConnectTicketResponse = Static<typeof C.ConnectTicketResponse>;
export type Device = Static<typeof C.Device>;
export type DeviceList = Static<typeof C.DeviceList>;
export type DevicePatch = Static<typeof C.DevicePatch>;

export type SessionSnapshot = Static<typeof C.SessionSnapshot>;
export type SessionSummary = Static<typeof C.SessionSummary>;
export type TranscriptItem = Static<typeof C.TranscriptItem>;
export type SessionList = Static<typeof C.SessionList>;
export type CreateSessionRequest = Static<typeof C.CreateSessionRequest>;
export type SessionResponse = Static<typeof C.SessionResponse>;
export type PromptRequest = Static<typeof C.PromptRequest>;
export type PromptResponse = Static<typeof C.PromptResponse>;
export type QueueModeRequest = Static<typeof C.QueueModeRequest>;
export type CompactRequest = Static<typeof C.CompactRequest>;
export type SetModelRequest = Static<typeof C.SetModelRequest>;
export type SetThinkingRequest = Static<typeof C.SetThinkingRequest>;
export type ForkRequest = Static<typeof C.ForkRequest>;
export type EntriesResponse = Static<typeof C.EntriesResponse>;
export type StatsResponse = Static<typeof C.StatsResponse>;
export type TreeResponse = Static<typeof C.TreeResponse>;
export type DialogRespondRequest = Static<typeof C.DialogRespondRequest>;
export type DialogRespondResponse = Static<typeof C.DialogRespondResponse>;

export type Project = Static<typeof C.Project>;
export type Workspace = Static<typeof C.Workspace>;
export type Group = Static<typeof C.Group>;
export type ProjectList = Static<typeof C.ProjectList>;
export type WorkspaceList = Static<typeof C.WorkspaceList>;
export type GroupList = Static<typeof C.GroupList>;
export type GroupExpanded = Static<typeof C.GroupExpanded>;
export type RegisterWorkspaceRequest = Static<typeof C.RegisterWorkspaceRequest>;
export type RegisterWorkspaceResponse = Static<typeof C.RegisterWorkspaceResponse>;
export type ProjectPatch = Static<typeof C.ProjectPatch>;
export type WorkspacePatch = Static<typeof C.WorkspacePatch>;
export type GroupCreate = Static<typeof C.GroupCreate>;
export type GroupPatch = Static<typeof C.GroupPatch>;
export type CreateWorktreeRequest = Static<typeof C.CreateWorktreeRequest>;
export type WorkspaceStatus = Static<typeof C.WorkspaceStatus>;
export type FileTreeEntry = Static<typeof C.FileTreeEntry>;
export type FileTreeResponse = Static<typeof C.FileTreeResponse>;
export type FileMeta = Static<typeof C.FileMeta>;
export type DiffResponse = Static<typeof C.DiffResponse>;

export type TerminalInfo = Static<typeof C.TerminalInfo>;
export type TerminalList = Static<typeof C.TerminalList>;
export type CreateTerminalRequest = Static<typeof C.CreateTerminalRequest>;
export type TerminalClientControl = Static<typeof C.TerminalClientControl>;
export type TerminalServerControl = Static<typeof C.TerminalServerControl>;

export type EventEnvelope = Static<typeof C.EventEnvelope>;
export type EventType = keyof typeof C.EventPayloads;
export type EventPayload<T extends EventType> = Static<(typeof C.EventPayloads)[T]>;
export type Event<T extends EventType = EventType> = Omit<EventEnvelope, "type" | "payload"> & {
  type: T;
  payload: EventPayload<T>;
};
export type ErrorBody = Static<typeof C.ErrorBody>;
