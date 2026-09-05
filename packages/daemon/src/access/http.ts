// The access routes of /v1 (spec §5.1, §6): pairing redemption (unauthenticated by construction,
// rate limited), connect tickets, and device management. Plain node:http; M5's router absorbs
// these unchanged.

import type http from "node:http";
import type { Logger } from "../os/log.ts";
import type { AccessControl, Principal } from "./authenticate.ts";
import { authenticate, hasRole, peerAddress } from "./authenticate.ts";
import type { DaemonIdentity } from "./daemon-identity.ts";
import type { PairingService } from "./pairing.ts";
import { RateLimiter } from "./ratelimit.ts";

export interface AccessRoutesOptions {
  access: AccessControl;
  pairing: PairingService;
  daemon: DaemonIdentity;
  /** The capability document, returned at redemption so a fresh client knows what it is talking to. */
  capabilities: () => unknown;
  /** Called after a device is revoked, so live connections can be closed. */
  onRevoked?: ((deviceId: string) => void) | undefined;
  redeemLimiter?: RateLimiter | undefined;
  ticketLimiter?: RateLimiter | undefined;
  log?: Logger | undefined;
  now?: (() => number) | undefined;
}

export type RouteHandler = (req: http.IncomingMessage, res: http.ServerResponse) => Promise<boolean>;

const MAX_BODY = 16 * 1024;

export function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
  });
  res.end(text);
}

export function sendError(
  res: http.ServerResponse,
  status: number,
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
): void {
  sendJson(res, status, { error: { code, message, ...extra } });
}

export async function readJson(req: http.IncomingMessage, limit = MAX_BODY): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new Error("body too large");
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/** Authenticate a plain HTTP request, writing the failure if there is one. */
export function requirePrincipal(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  access: AccessControl,
): Principal | null {
  const outcome = authenticate(req, access);
  if (outcome.ok) return outcome.principal;
  if (outcome.status === 401) res.setHeader("www-authenticate", 'Bearer realm="pi-daemon"');
  sendError(res, outcome.status, outcome.status === 429 ? "rate_limited" : "unauthorized", outcome.message);
  return null;
}

export function createAccessRoutes(options: AccessRoutesOptions): RouteHandler {
  const redeemLimiter =
    options.redeemLimiter ?? new RateLimiter({ windowMs: 60_000, max: 5, now: options.now });
  const ticketLimiter =
    options.ticketLimiter ?? new RateLimiter({ windowMs: 60_000, max: 30, now: options.now });
  const { access } = options;

  return async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const method = req.method ?? "GET";
    const p = url.pathname;

    if (method === "POST" && p === "/v1/pair/redeem") {
      const peer = peerAddress(req);
      const d = redeemLimiter.hit(peer);
      if (!d.allowed) {
        res.setHeader("retry-after", String(Math.ceil(d.retryAfterMs / 1000)));
        sendError(res, 429, "rate_limited", "too many pairing attempts");
        return true;
      }
      let body: Record<string, unknown>;
      try {
        body = (await readJson(req)) as Record<string, unknown>;
      } catch {
        sendError(res, 400, "bad_request", "body must be JSON");
        return true;
      }
      const result = await options.pairing.redeem({
        code: String(body.code ?? ""),
        deviceName: String(body.deviceName ?? "unnamed device"),
        platform: String(body.platform ?? "unknown"),
        peer,
      });
      if (!result.ok) {
        const status =
          result.reason === "invalid"
            ? 400
            : result.reason === "declined"
              ? 403
              : result.reason === "too_many_attempts"
                ? 429
                : 401;
        options.log?.info("pairing refused", { peer, reason: result.reason });
        sendError(res, status, `pairing_${result.reason}`, `pairing ${result.reason.replace(/_/g, " ")}`);
        return true;
      }
      options.log?.info("device paired", {
        deviceId: result.device.id,
        name: result.device.name,
        role: result.role,
        peer,
      });
      sendJson(res, 200, {
        daemonId: options.daemon.id,
        daemonName: options.daemon.name,
        deviceId: result.device.id,
        token: result.token,
        role: result.role,
        capabilities: options.capabilities(),
      });
      return true;
    }

    if (method === "POST" && p === "/v1/connect-tickets") {
      const principal = requirePrincipal(req, res, access);
      if (!principal) return true;
      const d = ticketLimiter.hit(principal.deviceId);
      if (!d.allowed) {
        sendError(res, 429, "rate_limited", "too many tickets");
        return true;
      }
      const { ticket, expiresAt } = access.tickets.mint(principal.deviceId, peerAddress(req));
      sendJson(res, 201, { ticket, expiresAt, ttlMs: access.tickets.ttlMs });
      return true;
    }

    if (p === "/v1/devices" && method === "GET") {
      const principal = requirePrincipal(req, res, access);
      if (!principal) return true;
      if (!hasRole(principal, "owner")) {
        sendError(res, 403, "forbidden", "owner role required");
        return true;
      }
      sendJson(res, 200, { devices: access.devices.list() });
      return true;
    }

    const deviceMatch = /^\/v1\/devices\/([0-9A-Z]{8,32})$/.exec(p);
    if (deviceMatch?.[1] && (method === "DELETE" || method === "PATCH")) {
      const id = deviceMatch[1];
      const principal = requirePrincipal(req, res, access);
      if (!principal) return true;
      if (!hasRole(principal, "owner")) {
        sendError(res, 403, "forbidden", "owner role required");
        return true;
      }
      if (method === "DELETE") {
        if (
          id === principal.deviceId &&
          access.devices.list().filter((d) => d.role === "owner").length <= 1
        ) {
          sendError(
            res,
            409,
            "last_owner",
            "the last owner cannot revoke itself; promote another device first",
          );
          return true;
        }
        if (!access.devices.revoke(id)) {
          sendError(res, 404, "not_found", "unknown device");
          return true;
        }
        access.tickets.dropDevice(id);
        options.onRevoked?.(id);
        options.log?.info("device revoked", { deviceId: id, by: principal.deviceId });
        res.writeHead(204).end();
        return true;
      }
      let body: Record<string, unknown>;
      try {
        body = (await readJson(req)) as Record<string, unknown>;
      } catch {
        sendError(res, 400, "bad_request", "body must be JSON");
        return true;
      }
      if (!access.devices.get(id)) {
        sendError(res, 404, "not_found", "unknown device");
        return true;
      }
      if (body.role === "owner" || body.role === "member") access.devices.setRole(id, body.role);
      if (typeof body.name === "string" && body.name.trim()) access.devices.rename(id, body.name.trim());
      const updated = access.devices.get(id);
      sendJson(res, 200, { device: updated ? { ...updated, secretHash: undefined } : null });
      return true;
    }

    return false;
  };
}
