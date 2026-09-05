// Connect tickets (spec §6.4): a browser cannot set headers on a WebSocket, so it mints a
// single-use, 30-second ticket over HTTPS and passes it as ?ticket=. Bound to the device and
// the peer address. A URL-borne credential is acceptable only under exactly those terms.

import { randomBytes } from "node:crypto";

interface Ticket {
  deviceId: string;
  peer: string | undefined;
  expiresAt: number;
}

export interface ConnectTicketsOptions {
  now?: (() => number) | undefined;
  ttlMs?: number | undefined;
  /** Outstanding tickets across all devices; beyond this the oldest is dropped. */
  maxOutstanding?: number | undefined;
}

export class ConnectTickets {
  readonly #tickets = new Map<string, Ticket>();
  readonly #now: () => number;
  readonly #ttlMs: number;
  readonly #max: number;

  constructor(options: ConnectTicketsOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#ttlMs = options.ttlMs ?? 30_000;
    this.#max = options.maxOutstanding ?? 256;
  }

  get ttlMs(): number {
    return this.#ttlMs;
  }

  mint(deviceId: string, peer?: string | undefined): { ticket: string; expiresAt: number } {
    this.#prune();
    const ticket = randomBytes(32).toString("base64url");
    const expiresAt = this.#now() + this.#ttlMs;
    this.#tickets.set(ticket, { deviceId, peer, expiresAt });
    while (this.#tickets.size > this.#max) {
      const oldest = this.#tickets.keys().next().value;
      if (oldest === undefined) break;
      this.#tickets.delete(oldest);
    }
    return { ticket, expiresAt };
  }

  /** Consume a ticket. Any failure is indistinguishable to the caller: null. */
  consume(ticket: string, peer?: string | undefined): { deviceId: string } | null {
    const t = this.#tickets.get(ticket);
    this.#tickets.delete(ticket);
    if (!t) return null;
    if (t.expiresAt <= this.#now()) return null;
    if (t.peer !== undefined && peer !== undefined && t.peer !== peer) return null;
    return { deviceId: t.deviceId };
  }

  /** Revocation: drop every ticket a device holds. */
  dropDevice(deviceId: string): void {
    for (const [k, t] of this.#tickets) if (t.deviceId === deviceId) this.#tickets.delete(k);
  }

  get outstanding(): number {
    this.#prune();
    return this.#tickets.size;
  }

  #prune(): void {
    const now = this.#now();
    for (const [k, t] of this.#tickets) if (t.expiresAt <= now) this.#tickets.delete(k);
  }
}
