// Leases (spec §4.4): one exclusive holder or any number of shared holders per session.
// Keyed by connection, because a connection closing releases everything it held.

export type LeaseMode = "exclusive" | "shared";

export interface Lease {
  sessionId: string;
  connectionId: string;
  mode: LeaseMode;
  acquiredAt: number;
}

export type AcquireResult = { ok: true; lease: Lease } | { ok: false; reason: "locked" };

export class LeaseTable {
  /** sessionId -> connectionId -> lease */
  readonly #bySession = new Map<string, Map<string, Lease>>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  acquire(sessionId: string, connectionId: string, mode: LeaseMode): AcquireResult {
    const holders = this.#bySession.get(sessionId) ?? new Map<string, Lease>();
    const existing = holders.get(connectionId);
    const others = [...holders.values()].filter((l) => l.connectionId !== connectionId);
    if (mode === "exclusive" && others.length > 0) return { ok: false, reason: "locked" };
    if (mode === "shared" && others.some((l) => l.mode === "exclusive"))
      return { ok: false, reason: "locked" };
    const lease: Lease = existing
      ? { ...existing, mode }
      : { sessionId, connectionId, mode, acquiredAt: this.#now() };
    holders.set(connectionId, lease);
    this.#bySession.set(sessionId, holders);
    return { ok: true, lease };
  }

  release(sessionId: string, connectionId: string): boolean {
    const holders = this.#bySession.get(sessionId);
    if (!holders?.delete(connectionId)) return false;
    if (holders.size === 0) this.#bySession.delete(sessionId);
    return true;
  }

  /** Everything a connection held. Returns the session ids it was attached to. */
  releaseAll(connectionId: string): string[] {
    const released: string[] = [];
    for (const [sessionId, holders] of this.#bySession) {
      if (holders.delete(connectionId)) released.push(sessionId);
      if (holders.size === 0) this.#bySession.delete(sessionId);
    }
    return released;
  }

  holds(sessionId: string, connectionId: string): boolean {
    return this.#bySession.get(sessionId)?.has(connectionId) ?? false;
  }

  holders(sessionId: string): Lease[] {
    return [...(this.#bySession.get(sessionId)?.values() ?? [])];
  }

  attachedCount(sessionId: string): number {
    return this.#bySession.get(sessionId)?.size ?? 0;
  }

  /** True when an exclusive lease exists for the session. */
  locked(sessionId: string): boolean {
    return this.holders(sessionId).some((l) => l.mode === "exclusive");
  }

  sessionsOf(connectionId: string): string[] {
    const out: string[] = [];
    for (const [sessionId, holders] of this.#bySession) if (holders.has(connectionId)) out.push(sessionId);
    return out;
  }
}
