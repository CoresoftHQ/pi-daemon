// The event log (spec §5.2): one global monotonic `seq`, a bounded replay ring, and resume
// from a watermark. A `since` older than the ring is a gap, and the caller must tell the client
// to re-read state rather than replay a partial history.

export type Scope = "daemon" | `workspace:${string}` | `session:${string}` | `terminal:${string}`;

export interface DaemonEvent {
  seq: number;
  scope: Scope;
  type: string;
  at: number;
  payload: unknown;
}

export interface EventLogOptions {
  /** Ring capacity in events. */
  maxEvents?: number | undefined;
  /** Ring capacity in serialised bytes (approximate). */
  maxBytes?: number | undefined;
  now?: (() => number) | undefined;
}

export type Subscriber = (event: DaemonEvent) => void;

export interface ReplayResult {
  events: DaemonEvent[];
  /** True when `since` predates the ring: the client must re-read state (snapshot.required). */
  gap: boolean;
  /** The seq a client should resume from next. */
  watermark: number;
}

export class EventLog {
  #seq = 0;
  #ring: DaemonEvent[] = [];
  #ringBytes = 0;
  #sizes: number[] = [];
  readonly #maxEvents: number;
  readonly #maxBytes: number;
  readonly #now: () => number;
  readonly #subscribers = new Set<Subscriber>();

  constructor(options: EventLogOptions = {}) {
    this.#maxEvents = options.maxEvents ?? 2000;
    this.#maxBytes = options.maxBytes ?? 8 * 1024 * 1024;
    this.#now = options.now ?? Date.now;
  }

  get seq(): number {
    return this.#seq;
  }

  /** Oldest seq still replayable, or seq+1 when the ring is empty. */
  get oldest(): number {
    return this.#ring[0]?.seq ?? this.#seq + 1;
  }

  append(scope: Scope, type: string, payload: unknown): DaemonEvent {
    const event: DaemonEvent = { seq: ++this.#seq, scope, type, at: this.#now(), payload };
    const size = approximateSize(payload) + 64;
    this.#ring.push(event);
    this.#sizes.push(size);
    this.#ringBytes += size;
    while (
      this.#ring.length > this.#maxEvents ||
      (this.#ringBytes > this.#maxBytes && this.#ring.length > 1)
    ) {
      this.#ring.shift();
      this.#ringBytes -= this.#sizes.shift() ?? 0;
    }
    for (const s of this.#subscribers) {
      try {
        s(event);
      } catch {
        /* a subscriber's failure is its own problem */
      }
    }
    return event;
  }

  /**
   * Events after `since`, filtered by scope. Gaps in seq are normal on a filtered stream and
   * are not loss; a `since` older than the ring is.
   */
  replay(since: number, scopes?: ReadonlySet<Scope> | null): ReplayResult {
    const watermark = this.#seq;
    if (since >= this.#seq) return { events: [], gap: false, watermark };
    const gap = since + 1 < this.oldest;
    if (gap) return { events: [], gap: true, watermark };
    const events = this.#ring.filter((e) => e.seq > since && (!scopes || scopes.has(e.scope)));
    return { events, gap: false, watermark };
  }

  subscribe(subscriber: Subscriber): () => void {
    this.#subscribers.add(subscriber);
    return () => {
      this.#subscribers.delete(subscriber);
    };
  }

  get size(): number {
    return this.#ring.length;
  }
}

function approximateSize(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
}
