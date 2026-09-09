// A terminal stream: binary frames are bytes, text frames are control. The first text frame is
// the snapshot; write its `data` into your emulator, then feed `onData` bytes as they come.

import type { TerminalServerControl } from "./types.ts";

export interface TerminalHandlers {
  /** Live output bytes, after the snapshot. */
  onData: (bytes: Uint8Array) => void;
  /** The screen as VT sequences, exactly once per attach, before any `onData`. */
  onSnapshot?: ((snapshot: Extract<TerminalServerControl, { type: "snapshot" }>) => void) | undefined;
  onControl?: ((frame: TerminalServerControl) => void) | undefined;
  onClose?: ((code: number, reason: string) => void) | undefined;
}

export interface TerminalConnection {
  send(input: Uint8Array | string): void;
  resize(cols: number, rows: number): void;
  ping(): void;
  close(): void;
}

export function attachTerminal(options: {
  url: string;
  ticket: () => Promise<string>;
  WebSocket: typeof WebSocket;
  handlers: TerminalHandlers;
}): Promise<TerminalConnection> {
  return new Promise((resolve, reject) => {
    void (async () => {
      const url = new URL(options.url);
      url.searchParams.set("ticket", await options.ticket());
      const ws = new options.WebSocket(url);
      ws.binaryType = "arraybuffer";
      const encoder = new TextEncoder();
      let opened = false;
      ws.onopen = () => {
        opened = true;
        resolve({
          send: (input) => ws.send(typeof input === "string" ? encoder.encode(input) : input),
          resize: (cols, rows) => ws.send(JSON.stringify({ type: "resize", cols, rows })),
          ping: () => ws.send(JSON.stringify({ type: "ping" })),
          close: () => ws.close(1000, "client closed"),
        });
      };
      ws.onmessage = (m) => {
        if (typeof m.data === "string") {
          const frame = JSON.parse(m.data) as TerminalServerControl;
          if (frame.type === "snapshot") options.handlers.onSnapshot?.(frame);
          options.handlers.onControl?.(frame);
        } else {
          options.handlers.onData(new Uint8Array(m.data as ArrayBuffer));
        }
      };
      ws.onclose = (e) => {
        if (!opened) reject(new Error(`terminal stream refused: ${e.code} ${e.reason}`));
        options.handlers.onClose?.(e.code, e.reason);
      };
      ws.onerror = () => {
        /* onclose follows */
      };
    })().catch(reject);
  });
}
