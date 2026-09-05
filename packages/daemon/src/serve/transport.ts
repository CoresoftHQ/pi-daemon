// A byte transport as the protocol server sees it: ordered chunks in, ordered chunks out, one
// terminal close. WebSocket, the local socket, and an in-memory pair for tests all fit it, so
// the protocol core is tested without opening a port.

export interface ByteDuplex {
  /** Deliver one inbound chunk. */
  onData(handler: (chunk: Uint8Array) => void): void;
  /** Called once when the peer is gone, however it went. */
  onClose(handler: (reason?: string) => void): void;
  send(chunk: Uint8Array): void;
  close(reason?: string): void;
  /** Bytes queued and not yet handed to the OS. For backpressure decisions. */
  readonly bufferedAmount: number;
  /** Human label for logs: peer address, pipe name, "memory". */
  readonly label: string;
}

/** An in-memory transport pair. `a` is the client end, `b` the server end. */
export function memoryPair(label = "memory"): { a: ByteDuplex; b: ByteDuplex } {
  const make = (
    name: string,
  ): ByteDuplex & {
    peer?: (ByteDuplex & { deliver(c: Uint8Array): void; gone(r?: string): void }) | undefined;
    deliver(c: Uint8Array): void;
    gone(r?: string): void;
  } => {
    let dataHandler: ((chunk: Uint8Array) => void) | null = null;
    let closeHandler: ((reason?: string) => void) | null = null;
    let closed = false;
    const pendingData: Uint8Array[] = [];
    const self = {
      label: `${label}:${name}`,
      bufferedAmount: 0,
      peer: undefined as (ByteDuplex & { deliver(c: Uint8Array): void; gone(r?: string): void }) | undefined,
      onData(h: (chunk: Uint8Array) => void) {
        dataHandler = h;
        for (const c of pendingData.splice(0)) h(c);
      },
      onClose(h: (reason?: string) => void) {
        closeHandler = h;
      },
      send(chunk: Uint8Array) {
        if (closed) return;
        // Deliver asynchronously and in order, like a real socket would.
        const copy = new Uint8Array(chunk);
        queueMicrotask(() => self.peer?.deliver(copy));
      },
      close(reason?: string) {
        if (closed) return;
        closed = true;
        const peer = self.peer;
        queueMicrotask(() => {
          closeHandler?.(reason);
          peer?.gone(reason);
        });
      },
      deliver(chunk: Uint8Array) {
        if (closed) return;
        if (dataHandler) dataHandler(chunk);
        else pendingData.push(chunk);
      },
      gone(reason?: string) {
        if (closed) return;
        closed = true;
        closeHandler?.(reason);
      },
    };
    return self;
  };
  const a = make("client");
  const b = make("server");
  a.peer = b;
  b.peer = a;
  return { a, b };
}
