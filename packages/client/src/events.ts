// The event stream as a client sees it: one socket, typed handlers, `since` tracked and
// replayed on reconnect, `snapshot.required` surfaced so the caller re-reads state.

import type { Event, EventType } from "./types.ts";

export interface EventStreamOptions {
  scopes?: string[] | undefined;
  /** Resume from this sequence number (the last one you saw). */
  since?: number | undefined;
  /** Reconnect with backoff when the socket drops. Default true. */
  reconnect?: boolean | undefined;
}

interface Internal extends EventStreamOptions {
  url: string;
  ticket: () => Promise<string>;
  WebSocket: typeof WebSocket;
}

type Handler<T extends EventType> = (event: Event<T>) => void;
type AnyHandler = (event: Event) => void;

export type StreamState = "connecting" | "open" | "closed";

export class EventStream {
  #o: Internal;
  #ws: WebSocket | null = null;
  #handlers = new Map<string, Set<AnyHandler>>();
  #stateHandlers = new Set<(state: StreamState, detail?: string) => void>();
  #scopes: Set<string>;
  #since: number;
  #closed = false;
  #attempt = 0;
  #timer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: Internal) {
    this.#o = options;
    this.#scopes = new Set(options.scopes ?? []);
    this.#since = options.since ?? 0;
    void this.#connect();
  }

  /** The last sequence number seen; store it to resume later with `since`. */
  get since(): number {
    return this.#since;
  }

  on<T extends EventType>(type: T, handler: Handler<T>): () => void;
  on(type: "*", handler: AnyHandler): () => void;
  on(type: string, handler: AnyHandler): () => void {
    const set = this.#handlers.get(type) ?? new Set();
    set.add(handler);
    this.#handlers.set(type, set);
    return () => {
      set.delete(handler);
    };
  }

  onState(handler: (state: StreamState, detail?: string) => void): () => void {
    this.#stateHandlers.add(handler);
    return () => {
      this.#stateHandlers.delete(handler);
    };
  }

  /** Change subscriptions without reconnecting. */
  subscribe(scopes: string[]): void {
    for (const s of scopes) this.#scopes.add(s);
    this.#send({ type: "subscribe", scopes });
  }

  unsubscribe(scopes: string[]): void {
    for (const s of scopes) this.#scopes.delete(s);
    this.#send({ type: "unsubscribe", scopes });
  }

  close(): void {
    this.#closed = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#ws?.close(1000, "client closed");
    this.#ws = null;
    this.#state("closed", "client closed");
  }

  #send(frame: unknown): void {
    if (this.#ws && this.#ws.readyState === this.#ws.OPEN) this.#ws.send(JSON.stringify(frame));
  }

  #state(state: StreamState, detail?: string): void {
    for (const h of this.#stateHandlers) h(state, detail);
  }

  async #connect(): Promise<void> {
    if (this.#closed) return;
    this.#state("connecting");
    let url: URL;
    try {
      url = new URL(this.#o.url);
      url.searchParams.set("ticket", await this.#o.ticket());
    } catch (err) {
      this.#retry(err instanceof Error ? err.message : String(err));
      return;
    }
    // 0 means "no opinion" (the daemon's default); anything else, including a stale or
    // deliberately ancient watermark, is sent so the daemon can answer snapshot.required.
    if (this.#since !== 0) url.searchParams.set("since", String(this.#since));
    if (this.#scopes.size > 0) url.searchParams.set("scopes", [...this.#scopes].join(","));
    const ws = new this.#o.WebSocket(url);
    this.#ws = ws;
    ws.onopen = () => {
      this.#attempt = 0;
      this.#state("open");
    };
    ws.onmessage = (m) => {
      let event: Event;
      try {
        event = JSON.parse(String(m.data)) as Event;
      } catch {
        return;
      }
      if (typeof event.seq === "number" && event.seq > this.#since) this.#since = event.seq;
      if (event.type === "snapshot.required") {
        const p = event.payload as { watermark: number };
        this.#since = p.watermark;
      }
      for (const h of this.#handlers.get(event.type) ?? []) h(event);
      for (const h of this.#handlers.get("*") ?? []) h(event);
    };
    ws.onclose = (e) => {
      if (this.#ws !== ws) return;
      this.#ws = null;
      if (this.#closed) return;
      this.#retry(`closed ${e.code} ${e.reason}`);
    };
    ws.onerror = () => {
      /* onclose follows */
    };
  }

  #retry(detail: string): void {
    if (this.#closed || this.#o.reconnect === false) {
      this.#state("closed", detail);
      return;
    }
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(this.#attempt++, 5));
    this.#state("connecting", `${detail}; retrying in ${delay} ms`);
    this.#timer = setTimeout(() => void this.#connect(), delay);
  }
}
