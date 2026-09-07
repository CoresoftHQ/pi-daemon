// The pairing QR (spec §6.2), rendered for a terminal. Pure JavaScript; a client that cannot
// scan gets the same payload as text beside it.

import { renderUnicodeCompact } from "uqr";

export function renderQr(text: string): string {
  return renderUnicodeCompact(text);
}
