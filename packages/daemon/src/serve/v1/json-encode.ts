// The JSON-side encoder (spec §5.3): canonical session state → the contract's shapes. A sibling
// of the CBOR encoder, not a layer over it; both read the same state and carry the same revision.

import type { SessionSnapshot, SessionSummary } from "@coresoft-hq/pi-daemon-contract";
import type { SessionSummary as HostSummary } from "../../sessions/host.ts";
import type { SessionState } from "../../sessions/state.ts";

export function toJsonSnapshot(state: SessionState): SessionSnapshot {
  return {
    id: state.id,
    workspaceId: state.workspaceId,
    ...(state.name ? { name: state.name } : {}),
    createdAt: Math.trunc(state.createdAt),
    updatedAt: Math.trunc(state.updatedAt),
    phase: state.phase,
    model: state.model,
    thinkingLevel: state.thinkingLevel,
    revision: state.revision,
    transcript: state.transcript,
    queuedSteer: state.queuedSteer,
    queuedSteerCount: state.queuedSteerCount,
    ...(state.runId ? { runId: state.runId } : {}),
    ...(state.interrupted ? { interrupted: state.interrupted } : {}),
    live: state.live,
    attachedCount: state.attachedCount,
  };
}

/** Paths never cross this surface: the host summary's cwd and file are dropped (spec §3). */
export function toJsonSummary(s: HostSummary): SessionSummary {
  return {
    id: s.id,
    ...(s.workspaceId ? { workspaceId: s.workspaceId } : {}),
    ...(s.name ? { name: s.name } : {}),
    createdAt: Math.trunc(s.createdAt),
    updatedAt: Math.trunc(s.updatedAt),
    live: s.live,
    ...(s.phase ? { phase: s.phase } : {}),
    ...(s.runId ? { runId: s.runId } : {}),
    ...(s.interrupted ? { interrupted: s.interrupted } : {}),
    attachedCount: s.attachedCount,
  };
}
