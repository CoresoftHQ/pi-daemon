// The loopback control endpoint (spec §8): how `pi-daemon stop|status|pair|devices` talk to a
// running daemon without a signal, which Windows does not have. Newline-delimited JSON over
// the local endpoint (Unix socket or named pipe), so filesystem permissions are the auth.
// One request per line; the daemon may send `event` lines before the `reply` for commands that
// wait on something (a pairing with --confirm).

import type net from "node:net";
import { createServer } from "node:net";
import { connectLocal, listenLocal, localEndpointPath } from "../os/ipc.ts";
import { createJsonlSplitter } from "../runners/jsonl.ts";

export const CONTROL_NAME = "pi-daemon-control";

export interface ControlRequest {
  id: number;
  cmd: string;
  params?: Record<string, unknown> | undefined;
}
export type ControlLine =
  | { id: number; reply: unknown }
  | { id: number; error: string }
  | { id: number; event: string; data?: unknown };

/** The daemon's side: a handler per command; `emit` sends an event line mid-command. */
export type ControlHandler = (
  params: Record<string, unknown>,
  ctx: {
    emit: (event: string, data?: unknown) => void;
    ask: (event: string, data?: unknown) => Promise<unknown>;
  },
) => Promise<unknown>;

export interface ControlServer {
  endpoint: string;
  close(): Promise<void>;
}

export function controlEndpoint(stateDir: string): string {
  return localEndpointPath(stateDir, CONTROL_NAME);
}

export async function startControlServer(
  stateDir: string,
  handlers: Record<string, ControlHandler>,
): Promise<ControlServer> {
  const endpoint = controlEndpoint(stateDir);
  const sockets = new Set<net.Socket>();
  const server = createServer((sock) => {
    sockets.add(sock);
    sock.on("close", () => sockets.delete(sock));
    sock.on("error", () => sock.destroy());
    const pendingAsks = new Map<number, (v: unknown) => void>();
    let askSeq = 0;
    const send = (line: ControlLine | { id: number; ask: number; event: string; data?: unknown }) => {
      if (!sock.destroyed) sock.write(`${JSON.stringify(line)}\n`);
    };
    const splitter = createJsonlSplitter(
      (msg) => {
        const m = (msg ?? {}) as Partial<ControlRequest> & { answer?: number; value?: unknown };
        if (typeof m.answer === "number") {
          pendingAsks.get(m.answer)?.(m.value);
          pendingAsks.delete(m.answer);
          return;
        }
        if (typeof m.id !== "number" || typeof m.cmd !== "string") {
          send({ id: typeof m.id === "number" ? m.id : 0, error: "expected { id, cmd, params? }" });
          return;
        }
        const id = m.id;
        const handler = handlers[m.cmd];
        if (!handler) {
          send({ id, error: `unknown command ${m.cmd}` });
          return;
        }
        const ctx = {
          emit: (event: string, data?: unknown) => send({ id, event, data }),
          ask: (event: string, data?: unknown) =>
            new Promise<unknown>((resolve) => {
              const ask = ++askSeq;
              pendingAsks.set(ask, resolve);
              send({ id, ask, event, data });
              sock.once("close", () => {
                if (pendingAsks.delete(ask)) resolve(undefined);
              });
            }),
        };
        handler(m.params ?? {}, ctx).then(
          (reply) => send({ id, reply: reply ?? null }),
          (err) => send({ id, error: err instanceof Error ? err.message : String(err) }),
        );
      },
      () => send({ id: 0, error: "not JSON" }),
    );
    sock.on("data", (chunk) => splitter.push(chunk));
  });
  await listenLocal(server, endpoint);
  return {
    endpoint,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}

export interface ControlClientOptions {
  timeoutMs?: number | undefined;
  /** Event lines before the reply. Return a value to answer an `ask`. */
  onEvent?: ((event: string, data: unknown) => Promise<unknown> | unknown) | undefined;
}

/** One request, one reply; resolves with the reply or rejects with the daemon's error. */
export function controlRequest(
  stateDir: string,
  cmd: string,
  params: Record<string, unknown> = {},
  options: ControlClientOptions = {},
): Promise<unknown> {
  const endpoint = controlEndpoint(stateDir);
  return new Promise((resolve, reject) => {
    const sock = connectLocal(endpoint);
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
      sock.destroy();
    };
    const timer = setTimeout(
      () => done(() => reject(new Error(`control request ${cmd} timed out`))),
      options.timeoutMs ?? 5000,
    );
    sock.once("error", (err) => done(() => reject(new ControlUnreachableError(endpoint, err))));
    sock.once("close", () =>
      done(() => reject(new Error(`control connection closed before a reply to ${cmd}`))),
    );
    const splitter = createJsonlSplitter((record) => {
      if (typeof record !== "object" || record === null) return;
      const line = record as Record<string, unknown>;
      if ("reply" in line) return done(() => resolve(line.reply));
      if ("error" in line) return done(() => reject(new Error(String(line.error))));
      if (typeof line.event === "string") {
        clearTimeout(timer);
        void Promise.resolve(options.onEvent?.(line.event, line.data)).then((value) => {
          if (typeof line.ask === "number" && !sock.destroyed)
            sock.write(`${JSON.stringify({ answer: line.ask, value })}\n`);
        });
      }
    });
    sock.on("data", (chunk) => splitter.push(chunk));
    sock.once("connect", () => sock.write(`${JSON.stringify({ id: 1, cmd, params })}\n`));
  });
}

export class ControlUnreachableError extends Error {
  readonly endpoint: string;
  constructor(endpoint: string, cause: Error) {
    super(`no daemon is listening on ${endpoint} (${cause.message})`);
    this.name = "ControlUnreachableError";
    this.endpoint = endpoint;
  }
}
