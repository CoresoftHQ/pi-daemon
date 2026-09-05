// Tailnet awareness (spec §6.5): additive, never authoritative. The daemon reads
// `tailscale status --json` — the CLI is on PATH wherever Tailscale is installed, which spares
// us the LocalAPI socket's per-platform paths — to learn its own tailnet address and name, and
// to attach a peer's login to a connection for display or an optional allowlist. A token is
// still required, always.

import type { ExecResult } from "../os/service/exec.ts";
import { exec } from "../os/service/exec.ts";

export interface TailnetUser {
  id: number;
  loginName: string;
  displayName: string;
}

export interface TailnetPeer {
  ips: string[];
  dnsName: string;
  userId: number;
  online: boolean;
}

export interface TailnetStatus {
  running: boolean;
  /** This machine's tailnet addresses (IPv4 first). */
  ips: string[];
  /** MagicDNS name without the trailing dot, e.g. host.tailnet.ts.net. */
  dnsName: string | null;
  selfUserId: number | null;
  users: Map<number, TailnetUser>;
  /** Peers keyed by each of their addresses. */
  peersByIp: Map<string, TailnetPeer>;
}

export type TailscaleExec = (args: string[]) => Promise<ExecResult>;

export const runTailscale: TailscaleExec = (args) => exec("tailscale", args);

/** Parse the JSON of `tailscale status --json`. Tolerant of missing sections. */
export function parseStatus(json: unknown): TailnetStatus {
  const j = (json && typeof json === "object" ? json : {}) as Record<string, unknown>;
  const self = (j.Self && typeof j.Self === "object" ? j.Self : {}) as Record<string, unknown>;
  const users = new Map<number, TailnetUser>();
  for (const u of Object.values((j.User as Record<string, unknown>) ?? {})) {
    const o = u as Record<string, unknown>;
    if (typeof o.ID === "number")
      users.set(o.ID, {
        id: o.ID,
        loginName: String(o.LoginName ?? ""),
        displayName: String(o.DisplayName ?? ""),
      });
  }
  const peersByIp = new Map<string, TailnetPeer>();
  const addPeer = (p: Record<string, unknown>) => {
    const ips = Array.isArray(p.TailscaleIPs)
      ? p.TailscaleIPs.filter((x): x is string => typeof x === "string")
      : [];
    const peer: TailnetPeer = {
      ips,
      dnsName: stripDot(String(p.DNSName ?? "")),
      userId: typeof p.UserID === "number" ? p.UserID : -1,
      online: p.Online === true,
    };
    for (const ip of ips) peersByIp.set(ip, peer);
  };
  for (const p of Object.values((j.Peer as Record<string, unknown>) ?? {}))
    addPeer(p as Record<string, unknown>);
  if (Object.keys(self).length) addPeer(self);
  const selfIps = Array.isArray(self.TailscaleIPs)
    ? self.TailscaleIPs.filter((x): x is string => typeof x === "string")
    : [];
  return {
    running: j.BackendState === "Running",
    ips: [...selfIps].sort((a, b) => (a.includes(":") ? 1 : 0) - (b.includes(":") ? 1 : 0)),
    dnsName: typeof self.DNSName === "string" && self.DNSName ? stripDot(self.DNSName) : null,
    selfUserId: typeof self.UserID === "number" ? self.UserID : null,
    users,
    peersByIp,
  };
}

function stripDot(s: string): string {
  return s.endsWith(".") ? s.slice(0, -1) : s;
}

/** Run the CLI. null when Tailscale is absent or not running — reported, never fatal. */
export async function tailnetStatus(run: TailscaleExec = runTailscale): Promise<TailnetStatus | null> {
  const r = await run(["status", "--json"]);
  if (r.code !== 0) return null;
  try {
    const status = parseStatus(JSON.parse(r.stdout));
    return status.running ? status : null;
  } catch {
    return null;
  }
}

/** Strip an IPv4-mapped IPv6 prefix and any zone id. */
export function normaliseIp(ip: string): string {
  const bare = ip.replace(/^::ffff:/i, "").replace(/%.*$/, "");
  return bare;
}

/** Tailscale's CGNAT range and its ULA prefix. */
export function isTailnetAddress(ip: string): boolean {
  const n = normaliseIp(ip);
  const v4 = /^100\.(\d+)\.\d+\.\d+$/.exec(n);
  if (v4?.[1]) {
    const second = Number(v4[1]);
    return second >= 64 && second <= 127;
  }
  return /^fd7a:115c:a1e0:/i.test(n);
}

export interface TailnetIdentity {
  loginName: string;
  displayName: string;
  dnsName: string;
}

/** Who a tailnet peer address belongs to, per the last status. */
export function identityFor(status: TailnetStatus, ip: string): TailnetIdentity | null {
  const peer = status.peersByIp.get(normaliseIp(ip));
  if (!peer) return null;
  const user = status.users.get(peer.userId);
  if (!user) return null;
  return { loginName: user.loginName, displayName: user.displayName, dnsName: peer.dnsName };
}

/** A cached status, refreshed at most every `ttlMs`. */
export class TailnetStatusCache {
  #status: TailnetStatus | null = null;
  #fetchedAt = 0;
  #inflight: Promise<TailnetStatus | null> | null = null;
  readonly #run: TailscaleExec;
  readonly #ttlMs: number;
  readonly #now: () => number;

  constructor(
    options: {
      run?: TailscaleExec | undefined;
      ttlMs?: number | undefined;
      now?: (() => number) | undefined;
    } = {},
  ) {
    this.#run = options.run ?? runTailscale;
    this.#ttlMs = options.ttlMs ?? 30_000;
    this.#now = options.now ?? Date.now;
  }

  /** The last known status, refreshing in the background when stale. */
  current(): TailnetStatus | null {
    if (this.#now() - this.#fetchedAt > this.#ttlMs) void this.refresh();
    return this.#status;
  }

  async refresh(): Promise<TailnetStatus | null> {
    if (this.#inflight) return this.#inflight;
    this.#inflight = tailnetStatus(this.#run)
      .then((s) => {
        this.#status = s;
        this.#fetchedAt = this.#now();
        return s;
      })
      .finally(() => {
        this.#inflight = null;
      });
    return this.#inflight;
  }
}
