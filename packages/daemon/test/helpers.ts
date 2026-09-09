// Shared test helpers: polling with a deadline, and a seeded PRNG for the fuzzers.

import type { TestContext } from "node:test";

/** Poll `pred` until it returns a value; fail with the test's name after `ms`. */
export async function waitFor<T>(t: TestContext, pred: () => T | undefined, ms = 15_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = pred();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error(`timed out after ${ms}ms in ${t.name}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** xorshift32: deterministic, fast, good enough for chunk boundaries and payload shapes. */
export function rng(seed: number) {
  let s = seed >>> 0 || 1;
  const next = () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0x1_0000_0000;
  };
  return {
    next,
    int: (n: number) => Math.floor(next() * n),
    pick: <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)] as T,
  };
}
