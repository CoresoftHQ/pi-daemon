// The server half of pi-protocol (spec §4). Transport-neutral: every connection is a ByteDuplex,
// so the same core serves a WebSocket, the local socket, and an in-memory pair in tests.
//
// Consequences of adopting pi's schemas, all deliberate (spec §4.3): nothing is added to the
// message set; `cwd` is validated against the workspace resolver; commands we decline answer
// not_implemented; frame limits are configuration. Leases: the wire `attach` carries no mode,
// so every attachment over this surface is a shared lease — exclusivity is a client-local
// notion pi-client enforces itself, and `locked` here reports an exclusive holder taken through
// another surface.

import { randomUUID } from "node:crypto";
import type {
  ClientMessage,
  Command,
  CommandResult,
  ProtocolErrorCode,
  ServerMessage,
  ServerSnapshot,
} from "@earendil-works/pi-protocol";
import {
  createClientMessageDecoder,
  encodeServerMessage,
  isSupportedProtocolVersion,
} from "@earendil-works/pi-protocol";
import type { Logger } from "../../os/log.ts";
import type { SessionHost } from "../../sessions/host.ts";
import { RunnerCapError, SessionLockedError, SessionNotFoundError } from "../../sessions/host.ts";
import type { AvailableModel as RpcModel } from "../../sessions/models.ts";
import type { Session } from "../../sessions/session.ts";
import { SessionBusyError, SessionNotLiveError } from "../../sessions/session.ts";
import type { ByteDuplex } from "../transport.ts";
import type { WorkspaceResolver } from "../workspace-resolver.ts";
import { toModelMetadata, toProgress, toSessionMetadata, toSessionSnapshot } from "./encode.ts";

export class ProtocolError extends Error {
  readonly code: ProtocolErrorCode;
  readonly details: unknown;
  constructor(code: ProtocolErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "ProtocolError";
    this.code = code;
    this.details = details;
  }
}

export interface PiProtocolServerOptions {
  host: SessionHost;
  workspaces: WorkspaceResolver;
  /** Configured models, from a startup probe. Refreshable. */
  models: () => readonly RpcModel[];
  serverId?: string | undefined;
  maxFrameLength?: number | undefined;
  /** Close a connection whose outbound buffer exceeds this. */
  maxBufferedBytes?: number | undefined;
  /** Commands to answer with not_implemented (an operator lock-down). */
  disabledCommands?: ReadonlySet<Command["command"]> | undefined;
  log?: Logger | undefined;
}

interface Connection {
  id: string;
  transport: ByteDuplex;
  helloDone: boolean;
  closed: boolean;
  /** Per-session unsubscribe functions for the event fan-out. */
  subscriptions: Map<string, () => void>;
}

export class PiProtocolServer {
  readonly serverId: string;
  readonly #o: PiProtocolServerOptions;
  readonly #connections = new Map<string, Connection>();
  #serverRevision = 0;
  readonly #frameOptions: { maxFrameLength?: number };

  constructor(options: PiProtocolServerOptions) {
    this.#o = options;
    this.#frameOptions =
      options.maxFrameLength !== undefined ? { maxFrameLength: options.maxFrameLength } : {};
    this.serverId = options.serverId ?? `pid_${randomUUID()}`;
    // Session list changes are server-level state.
    options.host.log.subscribe((e) => {
      if (e.type === "session.created" || e.type === "session.evicted" || e.type === "runner.failed")
        this.#broadcastServerSnapshot();
    });
  }

  get connectionCount(): number {
    return this.#connections.size;
  }

  /** Adopt an already-authenticated transport. Authentication happened before this call (spec §4.3). */
  attachTransport(transport: ByteDuplex): string {
    const conn: Connection = {
      id: `conn_${randomUUID()}`,
      transport,
      helloDone: false,
      closed: false,
      subscriptions: new Map(),
    };
    this.#connections.set(conn.id, conn);
    const decoder = createClientMessageDecoder(this.#frameOptions);
    transport.onData((chunk) => {
      let messages: ClientMessage[];
      try {
        messages = decoder.push(chunk);
      } catch (err) {
        // Malformed or oversized bytes. Before hello we can still say why; after, the
        // connection is simply over — pi-protocol has no in-band error for a broken stream.
        this.#o.log?.warn("pi-protocol: bad frame", { connection: conn.id, error: (err as Error).message });
        if (!conn.helloDone)
          this.#send(conn, {
            type: "hello_error",
            error: { code: "invalid_request", message: (err as Error).message },
          });
        this.#close(conn, "bad frame");
        return;
      }
      for (const m of messages) void this.#handle(conn, m);
    });
    transport.onClose(() => this.#teardown(conn));
    return conn.id;
  }

  closeAll(reason = "server closing"): void {
    for (const c of [...this.#connections.values()]) this.#close(c, reason);
  }

  #send(conn: Connection, message: ServerMessage): void {
    if (conn.closed) return;
    let bytes: Uint8Array;
    try {
      bytes = encodeServerMessage(message, this.#frameOptions);
    } catch (err) {
      // Our own bug: the state producer emitted something pi's schema rejects. Loud, and never silent.
      this.#o.log?.error("pi-protocol: refusing to send an invalid message", {
        type: message.type,
        error: (err as Error).message,
      });
      throw err;
    }
    conn.transport.send(bytes);
    const limit = this.#o.maxBufferedBytes ?? 8 * 1024 * 1024;
    if (conn.transport.bufferedAmount > limit) {
      this.#o.log?.warn("pi-protocol: slow consumer disconnected", {
        connection: conn.id,
        buffered: conn.transport.bufferedAmount,
      });
      this.#close(conn, "slow consumer");
    }
  }

  #close(conn: Connection, reason: string): void {
    if (conn.closed) return;
    conn.closed = true;
    conn.transport.close(reason);
    this.#teardown(conn);
  }

  #teardown(conn: Connection): void {
    conn.closed = true;
    for (const unsub of conn.subscriptions.values()) unsub();
    conn.subscriptions.clear();
    this.#o.host.releaseConnection(conn.id);
    this.#connections.delete(conn.id);
  }

  #serverSnapshot(): ServerSnapshot {
    return {
      serverId: this.serverId,
      protocolVersion: 1,
      revision: this.#serverRevision,
      sessions: this.#o.host.list().map(toSessionMetadata),
      models: this.#o.models().map((m) => toModelMetadata(m)),
    };
  }

  #broadcastServerSnapshot(): void {
    this.#serverRevision += 1;
    const snapshot = this.#serverSnapshot();
    for (const c of this.#connections.values())
      if (c.helloDone) this.#send(c, { type: "event", event: { type: "server_snapshot", snapshot } });
  }

  #snapshotFor(conn: Connection, session: Session) {
    return toSessionSnapshot(session.state, {
      attached: this.#o.host.holds(session.id, conn.id),
      locked: this.#o.host.leases.locked(session.id) && !this.#o.host.holds(session.id, conn.id),
    });
  }

  /** Fan this session's snapshots and progress out to the connection while it holds a lease. */
  #subscribe(conn: Connection, session: Session): void {
    if (conn.subscriptions.has(session.id)) return;
    const onSnapshot = () =>
      this.#send(conn, {
        type: "event",
        event: { type: "session_snapshot", snapshot: this.#snapshotFor(conn, session) },
      });
    const onProgress = (p: Parameters<typeof toProgress>[0]) =>
      this.#send(conn, {
        type: "event",
        event: { type: "session_progress", sessionId: session.id, progress: toProgress(p) },
      });
    session.on("snapshot", onSnapshot);
    session.on("progress", onProgress);
    conn.subscriptions.set(session.id, () => {
      session.off("snapshot", onSnapshot);
      session.off("progress", onProgress);
    });
  }

  #unsubscribe(conn: Connection, sessionId: string): void {
    conn.subscriptions.get(sessionId)?.();
    conn.subscriptions.delete(sessionId);
  }

  async #handle(conn: Connection, message: ClientMessage): Promise<void> {
    if (conn.closed) return;
    if (!conn.helloDone) {
      if (message.type !== "hello") {
        this.#send(conn, {
          type: "hello_error",
          error: { code: "invalid_request", message: "the first message must be hello" },
        });
        return this.#close(conn, "no hello");
      }
      if (!isSupportedProtocolVersion(message.version)) {
        this.#send(conn, {
          type: "hello_error",
          error: { code: "version", message: `unsupported protocol version ${message.version}` },
        });
        return this.#close(conn, "version");
      }
      conn.helloDone = true;
      this.#send(conn, {
        type: "hello",
        version: 1,
        connectionId: conn.id,
        snapshot: this.#serverSnapshot(),
      });
      return;
    }
    if (message.type !== "request") return; // a second hello is ignored
    let result: CommandResult;
    try {
      result = await this.#execute(conn, message.request);
    } catch (err) {
      const e = this.#toProtocolError(err);
      this.#o.log?.debug("pi-protocol: request failed", {
        connection: conn.id,
        command: message.request.command,
        code: e.code,
        message: e.message,
      });
      this.#send(conn, {
        type: "response",
        id: message.id,
        ok: false,
        error: {
          code: e.code,
          message: e.message,
          ...(e.details !== undefined ? { details: e.details as never } : {}),
        },
      });
      return;
    }
    this.#send(conn, { type: "response", id: message.id, ok: true, result });
  }

  #toProtocolError(err: unknown): ProtocolError {
    if (err instanceof ProtocolError) return err;
    if (err instanceof SessionNotFoundError) return new ProtocolError("not_found", err.message);
    if (err instanceof SessionLockedError) return new ProtocolError("session_locked", err.message);
    if (err instanceof SessionBusyError || err instanceof RunnerCapError)
      return new ProtocolError("busy", err.message);
    if (err instanceof SessionNotLiveError) return new ProtocolError("not_found", err.message);
    return new ProtocolError("internal_error", err instanceof Error ? err.message : String(err));
  }

  #requireAttached(conn: Connection, sessionId: string): Session {
    const host = this.#o.host;
    const session = host.get(sessionId);
    if (!session) throw new SessionNotFoundError(sessionId);
    if (!host.holds(sessionId, conn.id))
      throw new ProtocolError("invalid_request", `connection is not attached to session ${sessionId}`);
    return session;
  }

  async #execute(conn: Connection, request: Command): Promise<CommandResult> {
    if (this.#o.disabledCommands?.has(request.command))
      throw new ProtocolError("not_implemented", `${request.command} is disabled on this daemon`);
    const host = this.#o.host;
    switch (request.command) {
      case "list":
        return { command: "list", sessions: host.list().map(toSessionMetadata) };

      case "create": {
        const ws = this.#o.workspaces.resolveCwd(request.cwd);
        if (!ws.ok) throw new ProtocolError("invalid_request", ws.reason, { rule: "workspace" });
        const session = await host.create({
          workspaceId: ws.workspaceId,
          cwd: ws.cwd,
          ...(request.model ? { model: request.model } : {}),
          ...(request.thinkingLevel ? { thinkingLevel: request.thinkingLevel } : {}),
          ...(request.name ? { name: request.name } : {}),
        });
        await host.attach(session.id, conn.id, "shared");
        this.#subscribe(conn, session);
        return { command: "create", session: this.#snapshotFor(conn, session) };
      }

      case "attach": {
        const session = await host.attach(request.sessionId, conn.id, "shared");
        this.#subscribe(conn, session);
        return { command: "attach", session: this.#snapshotFor(conn, session) };
      }

      case "detach": {
        this.#unsubscribe(conn, request.sessionId);
        host.detach(request.sessionId, conn.id);
        return { command: "detach", sessionId: request.sessionId };
      }

      case "prompt": {
        const session = this.#requireAttached(conn, request.sessionId);
        await session.prompt(request.text); // busy if streaming: pi-protocol has no queue mode
        return { command: "prompt", session: this.#snapshotFor(conn, session) };
      }

      case "steer": {
        const session = this.#requireAttached(conn, request.sessionId);
        await session.steer(request.text);
        return { command: "steer", session: this.#snapshotFor(conn, session) };
      }

      case "abort": {
        const session = this.#requireAttached(conn, request.sessionId);
        await session.abort();
        return { command: "abort", session: this.#snapshotFor(conn, session) };
      }

      case "set_model": {
        const session = this.#requireAttached(conn, request.sessionId);
        await session.setModel(request.model.provider, request.model.id);
        return { command: "set_model", session: this.#snapshotFor(conn, session) };
      }

      case "set_thinking": {
        const session = this.#requireAttached(conn, request.sessionId);
        await session.setThinking(request.thinkingLevel);
        return { command: "set_thinking", session: this.#snapshotFor(conn, session) };
      }

      default:
        throw new ProtocolError(
          "not_implemented",
          `unknown command ${(request as { command: string }).command}`,
        );
    }
  }
}
