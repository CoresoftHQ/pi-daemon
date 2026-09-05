// `sessions`: canonical session state, the event log, leases, the dialog relay, eviction.

export type { SessionHeader } from "./catalog.ts";
export { readSessionHeaders } from "./catalog.ts";
export type { ClosedDialog, DialogResolution, PendingDialog, RespondResult } from "./dialogs.ts";
export { DialogTable } from "./dialogs.ts";
export type { DaemonEvent, EventLogOptions, ReplayResult, Scope, Subscriber } from "./events.ts";
export { EventLog } from "./events.ts";
export type { KnownSession, SessionHostOptions, SessionSummary } from "./host.ts";
export { RunnerCapError, SessionHost, SessionLockedError, SessionNotFoundError, scrubEnv } from "./host.ts";
export type { AcquireResult, Lease, LeaseMode } from "./leases.ts";
export { LeaseTable } from "./leases.ts";
export type { ProjectorOptions, ProjectorOutput } from "./projector.ts";
export { modelRef, Projector, usageOf } from "./projector.ts";
export type { PromptResult, SessionDeps, SessionEvents, SessionSpawnConfig } from "./session.ts";
export { Session, SessionBusyError, SessionNotLiveError } from "./session.ts";
export type * from "./state.ts";
export { cloneState } from "./state.ts";
