// A small fixed-window limiter (spec §7.5) for redemption, tickets, and failed upgrades — enough
// to make guessing a 120-second base32 code online uninteresting.

export interface RateLimiterOptions {
  windowMs: number;
  max: number;
  now?: (() => number) | undefined;
}

export interface RateDecision {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
}

export class RateLimiter {
  readonly #windows = new Map<string, { start: number; count: number }>();
  readonly #o: RateLimiterOptions;
  readonly #now: () => number;

  constructor(options: RateLimiterOptions) {
    this.#o = options;
    this.#now = options.now ?? Date.now;
  }

  hit(key: string): RateDecision {
    const now = this.#now();
    let w = this.#windows.get(key);
    if (!w || now - w.start >= this.#o.windowMs) {
      w = { start: now, count: 0 };
      this.#windows.set(key, w);
    }
    w.count += 1;
    const allowed = w.count <= this.#o.max;
    if (this.#windows.size > 10_000) this.#prune(now);
    return {
      allowed,
      remaining: Math.max(0, this.#o.max - w.count),
      retryAfterMs: allowed ? 0 : w.start + this.#o.windowMs - now,
    };
  }

  /** The decision a hit would get now, without counting one. */
  peek(key: string): RateDecision {
    const now = this.#now();
    const w = this.#windows.get(key);
    if (!w || now - w.start >= this.#o.windowMs)
      return { allowed: true, remaining: this.#o.max, retryAfterMs: 0 };
    const allowed = w.count < this.#o.max;
    return {
      allowed,
      remaining: Math.max(0, this.#o.max - w.count),
      retryAfterMs: allowed ? 0 : w.start + this.#o.windowMs - now,
    };
  }

  reset(key: string): void {
    this.#windows.delete(key);
  }

  #prune(now: number): void {
    for (const [k, w] of this.#windows) if (now - w.start >= this.#o.windowMs) this.#windows.delete(k);
  }
}
