// Device tokens (spec §6.1): `pid_<deviceId>_<secret>`. The daemon stores sha256(secret), never
// the token, and compares in constant time. deviceId is the lookup key so verification is one
// hash, not a scan.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { crockfordId, normaliseCrockford } from "../os/ids.ts";

export const TOKEN_PREFIX = "pid";
export { crockfordId, normaliseCrockford };

export interface MintedToken {
  token: string;
  deviceId: string;
  /** What the store keeps. */
  secretHash: string;
}

export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

export function mintToken(deviceId: string = crockfordId(10)): MintedToken {
  const secret = randomBytes(32).toString("base64url");
  return { token: `${TOKEN_PREFIX}_${deviceId}_${secret}`, deviceId, secretHash: hashSecret(secret) };
}

export interface ParsedToken {
  deviceId: string;
  secret: string;
}

const TOKEN_RE = /^pid_([0-9A-Z]{8,32})_([A-Za-z0-9_-]{40,48})$/;

export function parseToken(token: string): ParsedToken | null {
  const m = TOKEN_RE.exec(token);
  return m?.[1] && m[2] ? { deviceId: m[1], secret: m[2] } : null;
}

/** Constant-time comparison of a presented secret against a stored hash. */
export function verifySecret(secret: string, secretHash: string): boolean {
  const a = Buffer.from(hashSecret(secret), "hex");
  const b = Buffer.from(secretHash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}
