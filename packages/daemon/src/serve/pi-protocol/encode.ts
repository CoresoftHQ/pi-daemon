// The CBOR-side encoder (spec §5.3): canonical session state → pi-protocol shapes. Nothing here
// derives from the JSON encoder and nothing here is authoritative over it; both read the same
// state. Validation of the result is pi-protocol's own, at encodeServerMessage.

import type {
  ModelMetadata,
  SessionMetadata,
  SessionSnapshot,
  ThinkingLevel,
  TranscriptItem,
  TranscriptProgress,
} from "@earendil-works/pi-protocol";
import type { SessionSummary } from "../../sessions/host.ts";
import type { AvailableModel as RpcModel } from "../../sessions/models.ts";
import type { TranscriptItem as OurItem, Progress, SessionState } from "../../sessions/state.ts";

/** Our transcript items were shaped to match pi's; this is where that claim is pinned. */
export function toTranscriptItem(item: OurItem): TranscriptItem {
  return item as TranscriptItem;
}

/** The item type pi's schema admits for one progress kind. */
type ProgressItem<K extends TranscriptProgress["type"]> =
  Extract<TranscriptProgress, { type: K }> extends { item: infer I } ? I : never;

export function toSessionSnapshot(
  state: SessionState,
  view: { attached: boolean; locked: boolean },
): SessionSnapshot {
  return {
    id: state.id,
    ...(state.name ? { name: state.name } : {}),
    cwd: state.cwd,
    createdAt: Math.trunc(state.createdAt),
    updatedAt: Math.trunc(state.updatedAt),
    phase: state.phase,
    model: state.model,
    thinkingLevel: state.thinkingLevel,
    attached: view.attached,
    locked: view.locked,
    revision: state.revision,
    transcript: state.transcript.map(toTranscriptItem),
    queuedSteer: state.queuedSteer,
    queuedSteerCount: state.queuedSteerCount,
  };
}

export function toProgress(p: Progress): TranscriptProgress {
  switch (p.type) {
    case "item_started":
      return { type: "item_started", item: toTranscriptItem(p.item) };
    case "item_updated":
      return { type: "item_updated", item: p.item as ProgressItem<"item_updated"> };
    case "item_finished":
      return { type: "item_finished", item: p.item as ProgressItem<"item_finished"> };
    case "assistant_delta":
      return {
        type: "assistant_delta",
        messageId: p.messageId,
        contentIndex: p.contentIndex,
        kind: p.kind,
        delta: p.delta,
      };
  }
}

export function toSessionMetadata(s: SessionSummary): SessionMetadata {
  return {
    id: s.id,
    createdAt: Math.trunc(s.createdAt),
    updatedAt: Math.trunc(s.updatedAt),
    ...(s.name ? { sessionName: s.name } : {}),
    ...(s.cwd ? { cwd: s.cwd } : {}),
  };
}

const THINKING: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high"];

/** `get_available_models` lists configured models, not authenticated ones (M0 finding 7). */
export function toModelMetadata(m: RpcModel, authenticated = true): ModelMetadata {
  return {
    provider: m.provider,
    id: m.id,
    name: m.name ?? m.id,
    api: m.api ?? "unknown",
    reasoning: !!m.reasoning,
    input: (m.input ?? ["text"]).filter((x): x is "text" | "image" => x === "text" || x === "image"),
    contextWindow: Number.isInteger(m.contextWindow) ? (m.contextWindow as number) : 0,
    maxTokens: Number.isInteger(m.maxTokens) ? (m.maxTokens as number) : 0,
    cost: {
      input: m.cost?.input ?? 0,
      output: m.cost?.output ?? 0,
      cacheRead: m.cost?.cacheRead ?? 0,
      cacheWrite: m.cost?.cacheWrite ?? 0,
    },
    supportedThinkingLevels: m.reasoning ? THINKING : ["off"],
    authenticated,
  };
}
