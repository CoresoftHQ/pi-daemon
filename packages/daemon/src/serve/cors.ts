// CORS for browser clients served from another origin (spec §1 requirement 2). Off unless the
// operator lists origins; "*" is allowed explicitly. Bearer tokens are not cookies, so this is
// a browser courtesy rather than a security boundary: the token is still required.

import type http from "node:http";

const ALLOW_METHODS = "GET, HEAD, POST, PUT, PATCH, DELETE";
const ALLOW_HEADERS =
  "Authorization, Content-Type, If-Match, If-None-Match, Range, Idempotency-Key, Last-Event-ID";
const EXPOSE_HEADERS = "ETag, Content-Range, Idempotent-Replayed, X-File-Mode, X-File-Size";

/**
 * Add the CORS headers for an allowed origin, and answer a preflight outright. Returns true when
 * the request was a preflight and has been answered.
 */
export function applyCors(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  origins: readonly string[],
): boolean {
  const origin = req.headers.origin;
  if (!origin || origins.length === 0) return false;
  const allowed = origins.includes("*") || origins.includes(origin);
  if (!allowed) return false;
  res.setHeader("access-control-allow-origin", origin);
  res.setHeader("vary", "Origin");
  res.setHeader("access-control-expose-headers", EXPOSE_HEADERS);
  if (req.method === "OPTIONS" && req.headers["access-control-request-method"]) {
    res.writeHead(204, {
      "access-control-allow-methods": ALLOW_METHODS,
      "access-control-allow-headers": req.headers["access-control-request-headers"] ?? ALLOW_HEADERS,
      "access-control-max-age": "600",
    });
    res.end();
    return true;
  }
  return false;
}
