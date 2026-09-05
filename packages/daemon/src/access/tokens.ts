// Device tokens (spec §6.1): `pid_<deviceId>_<secret>`. The daemon stores sha256(secret), never
// the token, and compares in constant time. deviceId is the lookup key so verification is one
// hash, not a scan.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const TOKEN_PREFIX = "pid";
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Crockford base32 of random bytes — unambiguous under a camera and over a phone call. */
export function crockfordId(bytes = 10): string {
  const buf = randomBytes(bytes);
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of buf) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += CROCKFORD[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += CROCKFORD[(value << (5 - bits)) & 31];
  return out;
}

/** Normalise a human-entered Crockford string: case, dashes, and the I/L/O confusions. */
export function normaliseCrockford(s: string): string {
  return s.toUpperCase().replace(/[-\s]/g, "").replace(/[IL]/g, "1").replace(/O/g, "0");
}

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
