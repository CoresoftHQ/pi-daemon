// The two real transports for Surface A (spec §4.1): a WebSocket with binary frames at
// /pi/v1/socket, authenticated at the HTTP upgrade (§6.4), and the local socket / named pipe
// with no auth, where filesystem permissions are the boundary.

import type http from "node:http";
import type net from "node:net";
import type WebSocket from "ws";
import { WebSocketServer } from "ws";
import { listenLocal } from "../../os/ipc.ts";
import type { Logger } from "../../os/log.ts";
import type { ByteDuplex } from "../transport.ts";
import type { PiProtocolServer } from "./server.ts";

export const PI_PROTOCOL_PATH = "/pi/v1/socket";
export const PI_PROTOCOL_SUBPROTOCOL = "pi.v1";

export type UpgradeAuthResult =
  | { ok: true; principal?: string }
  | { ok: false; status: number; message: string };

export type UpgradeAuthenticator = (
  req: http.IncomingMessage,
) => UpgradeAuthResult | Promise<UpgradeAuthResult>;

/**
 * The M3 stand-in for access (§6): one static token, as a bearer header or ?token=. M4 replaces
 * this with device tokens and connect tickets; the upgrade contract stays the same.
 */
export function staticTokenAuthenticator(token: string): UpgradeAuthenticator {
  return (req) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const header = req.headers.authorization ?? "";
    const presented = header.startsWith("Bearer ") ? header.slice(7) : url.searchParams.get("token");
    return presented === token ? { ok: true } : { ok: false, status: 401, message: "unauthorized" };
  };
}

export function wsDuplex(ws: WebSocket, label: string): ByteDuplex {
  let closeHandler: ((reason?: string) => void) | null = null;
  let closed = false;
  const duplex: ByteDuplex = {
    label,
    get bufferedAmount() {
      return ws.bufferedAmount;
    },
    onData(h) {
      ws.on("message", (data, isBinary) => {
        if (!isBinary) {
          ws.close(1003, "binary frames only");
          return;
        }
        h(
          data instanceof Buffer
            ? new Uint8Array(data)
            : Array.isArray(data)
              ? new Uint8Array(Buffer.concat(data))
              : new Uint8Array(data as ArrayBuffer),
        );
      });
    },
    onClose(h) {
      closeHandler = h;
    },
    send(chunk) {
      if (ws.readyState === ws.OPEN) ws.send(chunk, { binary: true });
    },
    close(reason) {
      if (closed) return;
      closed = true;
      try {
        ws.close(1000, reason?.slice(0, 120));
      } catch {
        ws.terminate();
      }
    },
  };
  ws.once("close", () => {
    closed = true;
    closeHandler?.("closed");
  });
  ws.once("error", (err) => {
    closed = true;
    closeHandler?.(err.message);
  });
  return duplex;
}

export function socketDuplex(sock: net.Socket, label: string): ByteDuplex {
  let closeHandler: ((reason?: string) => void) | null = null;
  const duplex: ByteDuplex = {
    label,
    get bufferedAmount() {
      return sock.writableLength;
    },
    onData(h) {
      sock.on("data", (d: Buffer) => h(new Uint8Array(d)));
    },
    onClose(h) {
      closeHandler = h;
    },
    send(chunk) {
      if (!sock.destroyed) sock.write(chunk);
    },
    close(reason) {
      sock.end();
      setTimeout(() => sock.destroy(), 1000).unref();
      void reason;
    },
  };
  sock.once("close", () => closeHandler?.("closed"));
  sock.once("error", (err) => closeHandler?.(err.message));
  return duplex;
}

export interface WebSocketListenerOptions {
  server: PiProtocolServer;
  authenticate: UpgradeAuthenticator;
  path?: string | undefined;
  log?: Logger | undefined;
}

/**
 * Handle upgrades for the pi-protocol path on an existing HTTP server. Other paths are left
 * to other listeners; the composition root owns the final "no such path" refusal.
 */
export function attachWebSocketListener(
  httpServer: http.Server,
  options: WebSocketListenerOptions,
): WebSocketServer {
  const path = options.path ?? PI_PROTOCOL_PATH;
  const wss = new WebSocketServer({
    noServer: true,
    handleProtocols: (protocols) =>
      protocols.has(PI_PROTOCOL_SUBPROTOCOL) ? PI_PROTOCOL_SUBPROTOCOL : false,
  });
  const refuse = (socket: net.Socket, status: number, message: string) => {
    socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    socket.destroy();
  };
  httpServer.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== path) return;
    const protocols = String(req.headers["sec-websocket-protocol"] ?? "")
      .split(",")
      .map((s) => s.trim());
    if (!protocols.includes(PI_PROTOCOL_SUBPROTOCOL)) return refuse(socket as net.Socket, 400, "Bad Request");
    void Promise.resolve(options.authenticate(req)).then((auth) => {
      if (!auth.ok) {
        options.log?.info("pi-protocol: upgrade refused", {
          status: auth.status,
          remote: req.socket.remoteAddress,
        });
        return refuse(socket as net.Socket, auth.status, auth.message);
      }
      wss.handleUpgrade(req, socket as net.Socket, head, (ws) => {
        const label = `ws:${req.socket.remoteAddress ?? "?"}:${req.socket.remotePort ?? "?"}`;
        options.server.attachTransport(wsDuplex(ws, label));
      });
    });
  });
  return wss;
}

/** Listen on the local endpoint (Unix socket or named pipe). No auth: filesystem permissions. */
export async function listenLocalEndpoint(
  server: PiProtocolServer,
  endpoint: string,
  netServer: net.Server,
): Promise<void> {
  netServer.on("connection", (sock) => {
    server.attachTransport(socketDuplex(sock, `local:${endpoint}`));
  });
  await listenLocal(netServer, endpoint);
}
