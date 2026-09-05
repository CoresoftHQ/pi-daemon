// The event stream (spec §5.2): one connection per client, JSON envelopes, mutable scope
// subscriptions, `since` resume, and `snapshot.required` when the watermark predates the ring.
// WebSocket at /v1/events; SSE at /v1/events/sse for networks where a socket will not hold.

import type http from "node:http";
import type net from "node:net";
import { EventStreamControl } from "@coresoft-hq/pi-daemon-contract";
import { Value } from "typebox/value";
import type WebSocket from "ws";
import { WebSocketServer } from "ws";
import type { AccessControl } from "../../access/authenticate.ts";
import { authenticate } from "../../access/authenticate.ts";
import type { Logger } from "../../os/log.ts";
import type { DaemonEvent, EventLog, Scope } from "../../sessions/events.ts";

export const EVENTS_PATH = "/v1/events";
export const EVENTS_SSE_PATH = "/v1/events/sse";

function parseScopes(url: URL): Set<Scope> | null {
  const raw = url.searchParams.get("scopes");
  if (!raw) return null;
  const set = new Set<Scope>();
  for (const s of raw
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean))
    set.add(s as Scope);
  return set.size ? set : null;
}

function parseSince(url: URL, header?: string | undefined): number {
  const raw = url.searchParams.get("since") ?? header;
  const n = raw ? Number(raw) : 0;
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : 0;
}

function snapshotRequired(log: EventLog, watermark: number): DaemonEvent {
  return {
    seq: watermark,
    scope: "daemon",
    type: "snapshot.required",
    at: Date.now(),
    payload: { watermark, oldest: log.oldest },
  };
}

/**
 * Replay from `since` (or send snapshot.required), then stream live events matching the scope
 * filter. Returns the unsubscribe. `scopes` may be swapped by the caller for mutable subscriptions.
 */
function startStream(
  log: EventLog,
  since: number,
  filter: { scopes: Set<Scope> | null },
  send: (e: DaemonEvent) => void,
): () => void {
  const replay = log.replay(since, filter.scopes);
  if (replay.gap) send(snapshotRequired(log, replay.watermark));
  else for (const e of replay.events) send(e);
  // Anything appended between replay and subscribe is delivered by the subscription below
  // only if it arrives after this point; the log is single-threaded, so the window is empty.
  return log.subscribe((e) => {
    if (!filter.scopes || filter.scopes.has(e.scope)) send(e);
  });
}

export interface EventStreamOptions {
  log: EventLog;
  access: AccessControl;
  logger?: Logger | undefined;
  maxBufferedBytes?: number | undefined;
  keepaliveMs?: number | undefined;
}

/** WebSocket: JSON text frames. Client control frames change subscriptions without reconnecting. */
export function attachEventWebSocket(httpServer: http.Server, options: EventStreamOptions): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });
  const refuse = (socket: net.Socket, status: number, message: string) => {
    socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    socket.destroy();
  };
  httpServer.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== EVENTS_PATH) return;
    const auth = authenticate(req, options.access, { allowTicket: true });
    if (!auth.ok) return refuse(socket as net.Socket, auth.status, auth.message);
    wss.handleUpgrade(req, socket as net.Socket, head, (ws) => {
      const filter = { scopes: parseScopes(url) };
      const limit = options.maxBufferedBytes ?? 8 * 1024 * 1024;
      const send = (e: DaemonEvent) => {
        if (ws.readyState !== ws.OPEN) return;
        ws.send(JSON.stringify(e));
        if (ws.bufferedAmount > limit) {
          options.logger?.warn("events: slow consumer disconnected", { device: auth.principal.deviceId });
          ws.close(1008, "slow consumer");
        }
      };
      const unsubscribe = startStream(options.log, parseSince(url), filter, send);
      ws.on("message", (data: WebSocket.RawData) => {
        let control: unknown;
        try {
          control = JSON.parse(data.toString());
        } catch {
          return;
        }
        if (!Value.Check(EventStreamControl, control)) return;
        if (control.type === "subscribe") {
          const next = new Set<Scope>(filter.scopes ?? []);
          for (const s of control.scopes) next.add(s as Scope);
          filter.scopes = next;
        } else if (control.type === "unsubscribe") {
          if (filter.scopes) for (const s of control.scopes) filter.scopes.delete(s as Scope);
        } else if (control.type === "ping") {
          ws.send(JSON.stringify({ type: "pong", seq: options.log.seq }));
        }
      });
      const keepalive = setInterval(() => {
        if (ws.readyState === ws.OPEN) ws.ping();
      }, options.keepaliveMs ?? 25_000);
      keepalive.unref();
      ws.once("close", () => {
        clearInterval(keepalive);
        unsubscribe();
      });
    });
  });
  return wss;
}

/** SSE: `id` is the seq, so Last-Event-ID resumes; `event` is the type; `data` is the envelope. */
export function handleEventSse(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  options: EventStreamOptions,
): void {
  const url = new URL(req.url ?? "/", "http://localhost");
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  res.write(":ok\n\n");
  const filter = { scopes: parseScopes(url) };
  const send = (e: DaemonEvent) => {
    if (res.destroyed) return;
    res.write(`id: ${e.seq}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
    if (res.writableLength > (options.maxBufferedBytes ?? 8 * 1024 * 1024)) res.destroy();
  };
  const lastEventId = req.headers["last-event-id"];
  const unsubscribe = startStream(
    options.log,
    parseSince(url, Array.isArray(lastEventId) ? lastEventId[0] : lastEventId),
    filter,
    send,
  );
  const keepalive = setInterval(() => {
    if (!res.destroyed) res.write(":keepalive\n\n");
  }, options.keepaliveMs ?? 15_000);
  keepalive.unref();
  const done = () => {
    clearInterval(keepalive);
    unsubscribe();
  };
  req.once("close", done);
  res.once("close", done);
}
