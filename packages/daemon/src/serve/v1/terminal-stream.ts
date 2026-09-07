// The terminal byte stream (spec §5.5): `wss://…/v1/terminals/:id/stream`. Binary frames are
// PTY bytes both ways; text frames are the small JSON control channel. On attach the server
// sends a `snapshot` (the screen as VT sequences) and then live bytes, so a reconnecting phone
// sees the terminal as it is. A client that cannot keep up is cut with a reason; the PTY read
// loop never waits for anyone.

import type http from "node:http";
import type net from "node:net";
import type { TerminalClientControl } from "@coresoft-hq/pi-daemon-contract";
import { TerminalClientControl as ClientControlSchema } from "@coresoft-hq/pi-daemon-contract";
import { Value } from "typebox/value";
import type WebSocket from "ws";
import { WebSocketServer } from "ws";
import type { Logger } from "../../os/log.ts";
import type { TerminalManager } from "../../terminals/manager.ts";
import type { Terminal } from "../../terminals/terminal.ts";
import type { UpgradeAuthenticator } from "../pi-protocol/ws.ts";

export const TERMINAL_STREAM_PATTERN = /^\/v1\/terminals\/([^/]+)\/stream$/;

export interface TerminalStreamOptions {
  manager: TerminalManager;
  authenticate: UpgradeAuthenticator;
  /** Per-connection cap on unsent bytes before the client is disconnected. */
  maxBufferedBytes?: number | undefined;
  log?: Logger | undefined;
}

export function attachTerminalStream(
  httpServer: http.Server,
  options: TerminalStreamOptions,
): WebSocketServer {
  // Input frames are keystrokes and pastes; a paste is not a megabyte.
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  const limit = options.maxBufferedBytes ?? 4 * 1024 * 1024;
  const refuse = (socket: net.Socket, status: number, message: string) => {
    socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    socket.destroy();
  };
  httpServer.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const m = TERMINAL_STREAM_PATTERN.exec(url.pathname);
    if (!m) return;
    const id = decodeURIComponent(m[1] ?? "");
    void Promise.resolve(options.authenticate(req)).then((auth) => {
      if (!auth.ok) return refuse(socket as net.Socket, auth.status, auth.message);
      const terminal = options.manager.get(id);
      if (!terminal) return refuse(socket as net.Socket, 404, "Not Found");
      wss.handleUpgrade(req, socket as net.Socket, head, (ws) => {
        void attach(ws, terminal, { limit, log: options.log, deviceId: auth.principal ?? "unknown" });
      });
    });
  });
  return wss;
}

async function attach(
  ws: WebSocket,
  terminal: Terminal,
  ctx: { limit: number; log: Logger | undefined; deviceId: string },
): Promise<void> {
  ws.binaryType = "nodebuffer";
  let ready = false;
  let open = true;
  const queue: Buffer[] = [];
  const sendText = (frame: unknown) => {
    if (open && ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame));
  };
  const sendBytes = (bytes: Buffer) => {
    if (!open || ws.readyState !== ws.OPEN) return;
    if (ws.bufferedAmount > ctx.limit) {
      ctx.log?.warn("terminal: slow consumer disconnected", {
        terminalId: terminal.id,
        device: ctx.deviceId,
      });
      open = false;
      ws.close(1008, "slow consumer");
      return;
    }
    ws.send(bytes);
  };

  // Attach before serialising so nothing between the snapshot point and the first live byte is lost:
  // bytes that arrive while the snapshot is being produced wait in the queue and follow it.
  const detach = terminal.attach((bytes) => {
    if (ready) sendBytes(bytes);
    else queue.push(bytes);
  });
  const offTitle = terminal.onTitle((title) => sendText({ type: "title", title }));
  const offResize = terminal.onResize((cols, rows) => sendText({ type: "resize", cols, rows }));
  const cleanup = () => {
    open = false;
    detach();
    offTitle();
    offResize();
  };
  ws.on("close", cleanup);
  ws.on("error", cleanup);

  ws.on("message", (data, isBinary) => {
    if (!open) return;
    if (isBinary) {
      terminal.write(data as Buffer);
      return;
    }
    let frame: unknown;
    try {
      frame = JSON.parse(data.toString());
    } catch {
      ws.close(1007, "control frames are JSON");
      return;
    }
    if (!Value.Check(ClientControlSchema, frame)) {
      ws.close(1007, "unknown control frame");
      return;
    }
    const control = frame as TerminalClientControl;
    if (control.type === "resize") terminal.resize(control.cols, control.rows);
    else if (control.type === "ping") sendText({ type: "pong" });
  });

  void terminal.exited().then((exit) => {
    if (!open) return;
    sendText({ type: "exit", exit });
    open = false;
    ws.close(1000, "terminal exited");
  });

  try {
    const data = await terminal.snapshot();
    if (!open) return;
    sendText({ type: "snapshot", cols: terminal.cols, rows: terminal.rows, title: terminal.title, data });
  } catch (err) {
    ctx.log?.warn("terminal: snapshot failed", {
      terminalId: terminal.id,
      error: err instanceof Error ? err.message : String(err),
    });
    ws.close(1011, "snapshot failed");
    return;
  }
  ready = true;
  for (const bytes of queue.splice(0)) sendBytes(bytes);
  if (terminal.status === "exited" && terminal.exit) {
    sendText({ type: "exit", exit: terminal.exit });
    open = false;
    ws.close(1000, "terminal exited");
  }
}
