// Pairing (spec §6.2): a short-lived, single-use code, one active at a time, dead after a few
// failed attempts. It is not the durable secret — it buys one token, once. The QR payload
// carries the certificate fingerprint so a code photographed off a screen cannot be redeemed
// against someone else's endpoint.

import type { DeviceStore, DeviceView, Role } from "./devices.ts";
import { crockfordId, normaliseCrockford } from "./tokens.ts";

export interface PairingCode {
  /** Grouped for humans: XXXX-XXXX. */
  code: string;
  issuedAt: number;
  expiresAt: number;
  attempts: number;
}

export interface PairingPayload {
  v: 1;
  host: string;
  port: number;
  /** sha256 of the TLS certificate's SPKI, hex. Absent only on plaintext loopback. */
  fp?: string;
  code: string;
  /** For clients that file pairings per daemon before their first capabilities call. */
  daemonId: string;
}

export interface RedeemRequest {
  code: string;
  deviceName: string;
  platform: string;
  /** Peer address, for the confirm hook and the audit log. */
  peer?: string | undefined;
}

export type RedeemResult =
  | { ok: true; device: DeviceView; token: string; role: Role }
  | {
      ok: false;
      reason: "no_active_code" | "expired" | "mismatch" | "too_many_attempts" | "declined" | "invalid";
    };

export interface PairingOptions {
  devices: DeviceStore;
  daemonId: string;
  now?: (() => number) | undefined;
  ttlMs?: number | undefined;
  maxAttempts?: number | undefined;
  /** `pair --confirm`: a local y/N at the moment of redemption. */
  confirm?: ((request: RedeemRequest) => Promise<boolean>) | undefined;
  /** Observed redemptions, for the CLI to print. */
  onRedeemed?: ((device: DeviceView, request: RedeemRequest) => void) | undefined;
}

function group(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4, 8)}`;
}

export class PairingService {
  readonly #o: PairingOptions;
  readonly #now: () => number;
  #active: PairingCode | null = null;
  #redeeming = false;

  constructor(options: PairingOptions) {
    this.#o = options;
    this.#now = options.now ?? Date.now;
  }

  get ttlMs(): number {
    return this.#o.ttlMs ?? 120_000;
  }

  /** Issue a new code, replacing any active one. */
  issue(): PairingCode {
    const now = this.#now();
    this.#active = {
      code: group(crockfordId(5).slice(0, 8)),
      issuedAt: now,
      expiresAt: now + this.ttlMs,
      attempts: 0,
    };
    return this.#active;
  }

  active(): PairingCode | null {
    if (this.#active && this.#active.expiresAt <= this.#now()) this.#active = null;
    return this.#active;
  }

  cancel(): void {
    this.#active = null;
  }

  payload(endpoint: { host: string; port: number; fingerprint?: string | undefined }): PairingPayload | null {
    const active = this.active();
    if (!active) return null;
    return {
      v: 1,
      host: endpoint.host,
      port: endpoint.port,
      ...(endpoint.fingerprint ? { fp: endpoint.fingerprint } : {}),
      code: active.code,
      daemonId: this.#o.daemonId,
    };
  }

  async redeem(request: RedeemRequest): Promise<RedeemResult> {
    if (
      typeof request.code !== "string" ||
      typeof request.deviceName !== "string" ||
      typeof request.platform !== "string"
    )
      return { ok: false, reason: "invalid" };
    const active = this.active();
    if (!active) return { ok: false, reason: this.#active === null ? "no_active_code" : "expired" };
    if (this.#redeeming) return { ok: false, reason: "mismatch" };
    if (normaliseCrockford(request.code) !== normaliseCrockford(active.code)) {
      active.attempts += 1;
      if (active.attempts >= (this.#o.maxAttempts ?? 5)) {
        this.#active = null;
        return { ok: false, reason: "too_many_attempts" };
      }
      return { ok: false, reason: "mismatch" };
    }
    // Single use: the code is consumed before any await, so a concurrent redeem cannot reuse it.
    this.#active = null;
    this.#redeeming = true;
    try {
      if (this.#o.confirm && !(await this.#o.confirm(request))) return { ok: false, reason: "declined" };
      const { device, token } = this.#o.devices.create({
        name: request.deviceName,
        platform: request.platform,
      });
      this.#o.onRedeemed?.(device, request);
      return { ok: true, device, token, role: device.role };
    } finally {
      this.#redeeming = false;
    }
  }
}
