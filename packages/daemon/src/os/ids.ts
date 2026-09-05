// Random identifiers (spec §3): Crockford base32 of random bytes — unambiguous under a camera
// and over a phone call, and the same alphabet for every id the daemon mints.

import { randomBytes } from "node:crypto";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

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
