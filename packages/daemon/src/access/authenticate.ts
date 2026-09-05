// Every request and every upgrade is authenticated (spec §6). Bearer device tokens for native
// clients; single-use connect tickets for browsers on the socket upgrade; tailnet identity as an
// additive check and a display field, never as the credential.

import type http from "node:http";
import type { DeviceRecord, DeviceStore, Role } from "./devices.ts";
import type { RateLimiter } from "./ratelimit.ts";
import type { TailnetStatus } from "./tailscale.ts";
import { identityFor, isTailnetAddress, normaliseIp } from "./tailscale.ts";
import type { ConnectTickets } from "./tickets.ts";

export interface Principal {
  deviceId: string;
  role: Role;
  name: string;
  tailnetUser?: string;
}

export type AuthFailure = { ok: false; status: 401 | 403 | 429; message: string };
export type AuthOutcome = { ok: true; principal: Principal } | AuthFailure;

/** Structurally what serve's WebSocket listener expects; defined here so access never imports serve. */
export type UpgradeAuthResult =
  | { ok: true; principal?: string }
  | { ok: false; status: number; message: string };
export type UpgradeAuthenticator = (
  req: http.IncomingMessage,
) => UpgradeAuthResult | Promise<UpgradeAuthResult>;

export interface AccessControl {
  devices: DeviceStore;
  tickets: ConnectTickets;
  /** Failed attempts per peer address. */
  failures?: RateLimiter | undefined;
  tailnet?:
    | {
        status: () => TailnetStatus | null;
        /** Login names allowed to connect from the tailnet. Empty or absent means no restriction. */
        allowedUsers?: readonly string[] | undefined;
      }
    | undefined;
}

export function peerAddress(req: http.IncomingMessage): string {
  return normaliseIp(req.socket.remoteAddress ?? "");
}

function bearer(req: http.IncomingMessage): string | null {
  const h = req.headers.authorization;
  if (!h || Array.isArray(h)) return null;
  return h.startsWith("Bearer ") ? h.slice(7).trim() : null;
}

function principalOf(d: DeviceRecord): Principal {
  return {
    deviceId: d.id,
    role: d.role,
    name: d.name,
    ...(d.tailnetUser ? { tailnetUser: d.tailnetUser } : {}),
  };
}

/**
 * Authenticate an HTTP request or a WebSocket upgrade. `allowTicket` is true only for the
 * upgrade: a ticket in a URL is acceptable there and nowhere else.
 */
export function authenticate(
  req: http.IncomingMessage,
  access: AccessControl,
  options: { allowTicket?: boolean } = {},
): AuthOutcome {
  const peer = peerAddress(req);
  // A peer that has failed too often recently is refused before any credential is examined.
  if (access.failures && !access.failures.peek(peer).allowed)
    return { ok: false, status: 429, message: "too many failed attempts" };
  const fail = (status: 401 | 403, message: string): AuthFailure => {
    if (access.failures && status === 401) {
      const d = access.failures.hit(peer);
      if (!d.allowed) return { ok: false, status: 429, message: "too many failed attempts" };
    }
    return { ok: false, status, message };
  };

  let device: DeviceRecord | undefined | null;
  const token = bearer(req);
  if (token) {
    device = access.devices.verify(token);
    if (!device) return fail(401, "invalid token");
  } else if (options.allowTicket) {
    const url = new URL(req.url ?? "/", "http://localhost");
    const ticket = url.searchParams.get("ticket");
    if (!ticket) return fail(401, "missing credential");
    const consumed = access.tickets.consume(ticket, peer);
    device = consumed ? access.devices.get(consumed.deviceId) : null;
    if (!device) return fail(401, "invalid or expired ticket");
  } else {
    return fail(401, "missing credential");
  }

  // Tailnet identity: additive. A token is still required; this can only refuse, never admit.
  if (access.tailnet && isTailnetAddress(peer)) {
    const status = access.tailnet.status();
    const identity = status ? identityFor(status, peer) : null;
    const allowed = access.tailnet.allowedUsers;
    if (allowed && allowed.length > 0 && (!identity || !allowed.includes(identity.loginName)))
      return { ok: false, status: 403, message: "tailnet user is not allowed" };
    if (identity) access.devices.touch(device.id, { tailnetUser: identity.loginName });
  }
  access.failures?.reset(peer);
  return { ok: true, principal: principalOf(device) };
}

export function createUpgradeAuthenticator(access: AccessControl): UpgradeAuthenticator {
  return (req): UpgradeAuthResult => {
    const outcome = authenticate(req, access, { allowTicket: true });
    return outcome.ok
      ? { ok: true, principal: outcome.principal.deviceId }
      : { ok: false, status: outcome.status, message: outcome.message };
  };
}

/** owner satisfies member. */
export function hasRole(principal: Principal, required: Role): boolean {
  return required === "member" || principal.role === "owner";
}
