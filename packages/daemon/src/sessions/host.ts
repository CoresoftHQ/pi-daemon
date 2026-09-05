// The session host (spec §2.3 `sessions`): registry, leases, the dialog relay, eviction and the
// runner cap, and publication of everything into the event log. Knows nothing about wire formats.

import { randomUUID } from "node:crypto";
import type { Launcher } from "../os/spawn.ts";
import type { ExtensionUiResponse } from "../runners/rpc.ts";
import { readSessionHeaders } from "./catalog.ts";
import type { RespondResult } from "./dialogs.ts";
import { DialogTable } from "./dialogs.ts";
import { EventLog } from "./events.ts";
import type { LeaseMode } from "./leases.ts";
import { LeaseTable } from "./leases.ts";
import type { PromptResult, SessionSpawnConfig } from "./session.ts";
import { Session } from "./session.ts";
import type { Interrupted, Phase, SessionState } from "./state.ts";

export interface SessionHostOptions {
  log?: EventLog | undefined;
  launcher?: Launcher | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  /** Runner flags applied to every session (the operator's daemon configuration). */
  runner?:
    | Pick<
        SessionSpawnConfig,
        "extensions" | "isolate" | "tools" | "excludeTools" | "noTools" | "trust" | "sessionDir"
      >
    | undefined;
  /** pi's session directory, for enumerating sessions that are not live. */
  sessionsDir?: string | undefined;
  idleTimeoutMs?: number | undefined;
  maxRunners?: number | undefined;
  sweepIntervalMs?: number | undefined;
  now?: (() => number) | undefined;
  mintRunId?: (() => string) | undefined;
}

export interface KnownSession {
  id: string;
  workspaceId?: string;
  cwd: string;
  name?: string;
  createdAt: number;
  updatedAt: number;
  /** Explicit file, for sessions that live outside the default store. */
  file?: string;
}

export interface SessionSummary extends KnownSession {
  live: boolean;
  phase?: Phase;
  runId?: string;
  interrupted?: Interrupted;
  attachedCount: number;
}

export class SessionLockedError extends Error {
  constructor(id: string) {
    super(`session ${id} is held exclusively by another connection`);
    this.name = "SessionLockedError";
  }
}

export class SessionNotFoundError extends Error {
  constructor(id: string) {
    super(`unknown session ${id}`);
    this.name = "SessionNotFoundError";
  }
}

export class RunnerCapError extends Error {
  constructor(max: number) {
    super(`all ${max} runner slots are busy`);
    this.name = "RunnerCapError";
  }
}

/** Drop everything of ours, and anything that looks like a secret, from a runner's environment. */
export function scrubEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (/^PI_DAEMON_/i.test(k) && !/^PI_DAEMON_PI$/i.test(k)) continue;
    out[k] = v;
  }
  return out;
}

export class SessionHost {
  readonly log: EventLog;
  readonly leases: LeaseTable;
  readonly dialogs: DialogTable;
  readonly #sessions = new Map<string, Session>();
  readonly #known = new Map<string, KnownSession>();
  readonly #options: SessionHostOptions;
  readonly #now: () => number;
  readonly #mintRunId: () => string;
  readonly #env: NodeJS.ProcessEnv;
  #sweeper: NodeJS.Timeout | null = null;
  #closed = false;

  constructor(options: SessionHostOptions = {}) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
    this.#mintRunId = options.mintRunId ?? (() => `run_${randomUUID()}`);
    this.log = options.log ?? new EventLog({ now: this.#now });
    this.leases = new LeaseTable(this.#now);
    this.dialogs = new DialogTable({ now: this.#now });
    this.#env = scrubEnv(options.env ?? process.env);
    const sweep = options.sweepIntervalMs ?? 30_000;
    if (sweep > 0) {
      this.#sweeper = setInterval(() => void this.sweep(), sweep);
      this.#sweeper.unref();
    }
  }

  get idleTimeoutMs(): number {
    return this.#options.idleTimeoutMs ?? 30 * 60 * 1000;
  }

  get maxRunners(): number {
    return this.#options.maxRunners ?? 8;
  }

  get liveCount(): number {
    return [...this.#sessions.values()].filter((s) => s.live).length;
  }

  #config(cwd: string, workspaceId: string, file?: string): SessionSpawnConfig {
    const r = this.#options.runner ?? {};
    return {
      cwd,
      workspaceId,
      env: this.#env,
      launcher: this.#options.launcher,
      extensions: r.extensions,
      isolate: r.isolate,
      tools: r.tools,
      excludeTools: r.excludeTools,
      noTools: r.noTools,
      trust: r.trust,
      sessionDir: r.sessionDir,
      sessionFile: file,
    };
  }

  /** Register a session the daemon knows about but has not spawned (from the catalog or a move). */
  remember(known: KnownSession): void {
    if (!this.#known.has(known.id)) this.#known.set(known.id, known);
  }

  /** Create a new session in a workspace and spawn its runner. */
  async create(params: {
    workspaceId: string;
    cwd: string;
    model?: { provider: string; id: string };
    thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
    name?: string;
  }): Promise<Session> {
    this.#assertOpen();
    await this.#makeRoom();
    const session = await Session.create(this.#config(params.cwd, params.workspaceId), this.#deps());
    this.#register(session);
    this.#known.set(session.id, {
      id: session.id,
      workspaceId: params.workspaceId,
      cwd: params.cwd,
      createdAt: session.state.createdAt,
      updatedAt: session.state.updatedAt,
    });
    if (params.model) await session.setModel(params.model.provider, params.model.id);
    if (params.thinkingLevel) await session.setThinking(params.thinkingLevel);
    if (params.name) await session.setName(params.name);
    this.log.append("daemon", "session.created", { sessionId: session.id, workspaceId: params.workspaceId });
    this.#publishSnapshot(session);
    return session;
  }

  /** The live Session, if any. */
  get(id: string): Session | undefined {
    return this.#sessions.get(id);
  }

  /** Attach a connection: rehydrate if needed, then take a lease. */
  async attach(id: string, connectionId: string, mode: LeaseMode): Promise<Session> {
    this.#assertOpen();
    let session = this.#sessions.get(id);
    if (!session) {
      const known = this.#known.get(id) ?? this.#fromCatalog(id);
      if (!known) throw new SessionNotFoundError(id);
      await this.#makeRoom();
      session = await Session.open(
        id,
        this.#config(known.cwd, known.workspaceId ?? "", known.file),
        this.#deps(),
        known.createdAt,
      );
      this.#register(session);
    } else if (!session.live) {
      await this.#makeRoom();
      await session.ensureLive();
    }
    const acquired = this.leases.acquire(id, connectionId, mode);
    if (!acquired.ok) throw new SessionLockedError(id);
    session.projector.setAttachedCount(this.leases.attachedCount(id));
    session.touch();
    return session;
  }

  detach(id: string, connectionId: string): void {
    if (this.leases.release(id, connectionId))
      this.#sessions.get(id)?.projector.setAttachedCount(this.leases.attachedCount(id));
  }

  /** A connection went away: release everything it held. Turns keep running (spec §8). */
  releaseConnection(connectionId: string): void {
    for (const id of this.leases.releaseAll(connectionId))
      this.#sessions.get(id)?.projector.setAttachedCount(this.leases.attachedCount(id));
  }

  holds(id: string, connectionId: string): boolean {
    return this.leases.holds(id, connectionId);
  }

  prompt(id: string, text: string, during?: "steer" | "followUp"): Promise<PromptResult> {
    const s = this.#live(id);
    return s.prompt(text, { during });
  }

  respondDialog(dialogId: string, response: ExtensionUiResponse, answeredBy: string): RespondResult {
    const sessionId = dialogId.split(":")[0] ?? "";
    const session = this.#sessions.get(sessionId);
    if (!session) return this.dialogs.respond(dialogId, response, answeredBy);
    return session.respondDialog(dialogId, response, answeredBy);
  }

  list(): SessionSummary[] {
    const out = new Map<string, SessionSummary>();
    for (const h of this.#catalog())
      out.set(h.id, {
        id: h.id,
        cwd: h.cwd ?? "",
        ...(h.name ? { name: h.name } : {}),
        createdAt: h.createdAt,
        updatedAt: h.updatedAt,
        file: h.file,
        live: false,
        attachedCount: 0,
      });
    for (const k of this.#known.values())
      out.set(k.id, { ...(out.get(k.id) ?? {}), ...k, live: false, attachedCount: 0 } as SessionSummary);
    for (const s of this.#sessions.values()) {
      const st = s.state;
      out.set(s.id, {
        ...(out.get(s.id) ?? { createdAt: st.createdAt }),
        id: s.id,
        workspaceId: st.workspaceId,
        cwd: st.cwd,
        ...(st.name ? { name: st.name } : {}),
        createdAt: st.createdAt,
        updatedAt: st.updatedAt,
        live: s.live,
        phase: st.phase,
        ...(st.runId ? { runId: st.runId } : {}),
        ...(st.interrupted ? { interrupted: st.interrupted } : {}),
        attachedCount: st.attachedCount,
      });
    }
    return [...out.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async evict(id: string, reason: "idle" | "cap" | "shutdown" = "idle"): Promise<void> {
    const s = this.#sessions.get(id);
    if (!s?.live) return;
    await s.evict(reason);
    this.log.append(`session:${id}`, "session.evicted", { sessionId: id, reason });
  }

  /** Evict idle, unattached sessions past the idle timeout. */
  async sweep(): Promise<void> {
    const cutoff = this.#now() - this.idleTimeoutMs;
    for (const s of this.#sessions.values()) {
      if (s.live && s.state.attachedCount === 0 && s.state.phase === "idle" && s.lastActivityAt < cutoff)
        await this.evict(s.id, "idle");
    }
  }

  async close(): Promise<void> {
    this.#closed = true;
    if (this.#sweeper) clearInterval(this.#sweeper);
    this.log.append("daemon", "daemon.shutdown", { reason: "close" });
    await Promise.all([...this.#sessions.values()].map((s) => s.evict("shutdown")));
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("session host is closed");
  }

  #live(id: string): Session {
    const s = this.#sessions.get(id);
    if (!s) throw new SessionNotFoundError(id);
    return s;
  }

  #deps() {
    return { dialogs: this.dialogs, mintRunId: this.#mintRunId, now: this.#now };
  }

  /** Free a runner slot by evicting the least recently used idle, unattached session. */
  async #makeRoom(): Promise<void> {
    if (this.liveCount < this.maxRunners) return;
    const candidates = [...this.#sessions.values()]
      .filter((s) => s.live && s.state.attachedCount === 0 && s.state.phase === "idle")
      .sort((a, b) => a.lastActivityAt - b.lastActivityAt);
    const victim = candidates[0];
    if (!victim) throw new RunnerCapError(this.maxRunners);
    await this.evict(victim.id, "cap");
  }

  #catalog() {
    const dir = this.#options.sessionsDir;
    return dir ? readSessionHeaders(dir) : [];
  }

  #fromCatalog(id: string): KnownSession | undefined {
    const h = this.#catalog().find((x) => x.id === id);
    if (!h) return undefined;
    const known: KnownSession = {
      id,
      cwd: h.cwd ?? "",
      createdAt: h.createdAt,
      updatedAt: h.updatedAt,
      file: h.file,
      ...(h.name ? { name: h.name } : {}),
    };
    this.#known.set(id, known);
    return known;
  }

  #register(session: Session): void {
    this.#sessions.set(session.id, session);
    const scope = `session:${session.id}` as const;
    session.on("progress", (p) => this.log.append(scope, `transcript.${p.type}`, p));
    session.on("snapshot", (st) => this.#publishChanged(st));
    session.on("run_started", (runId) =>
      this.log.append(scope, "session.phase", { sessionId: session.id, phase: "turn", runId }),
    );
    session.on("run_settled", (runId) =>
      this.log.append(scope, "session.phase", { sessionId: session.id, phase: "idle", runId }),
    );
    session.on("dialog_opened", (d) =>
      this.log.append(scope, "dialog.opened", {
        dialogId: d.dialogId,
        sessionId: session.id,
        request: d.request,
      }),
    );
    session.on("dialog_closed", (d) =>
      this.log.append(scope, "dialog.closed", {
        dialogId: d.dialogId,
        sessionId: session.id,
        resolution: d.resolution,
        ...(d.answeredBy ? { answeredBy: d.answeredBy } : {}),
      }),
    );
    session.on("notice", (req) => this.log.append(scope, "notice", { sessionId: session.id, request: req }));
    session.on("interrupted", (i) =>
      this.log.append(scope, "session.interrupted", { sessionId: session.id, ...i }),
    );
    session.on("runner_exited", (exit) => {
      if (!exit.expected)
        this.log.append(scope, "runner.failed", {
          sessionId: session.id,
          code: exit.code,
          signal: exit.signal,
          stderrTail: exit.stderrTail.slice(-500),
        });
    });
  }

  #publishSnapshot(session: Session): void {
    this.#publishChanged(session.state);
  }

  #publishChanged(st: SessionState): void {
    // Light "revision bumped" event; the full snapshot is fetched, or carried on Surface A.
    this.log.append(`session:${st.id}`, "session.changed", {
      sessionId: st.id,
      revision: st.revision,
      phase: st.phase,
      live: st.live,
      ...(st.runId ? { runId: st.runId } : {}),
      ...(st.name ? { name: st.name } : {}),
      model: st.model,
      thinkingLevel: st.thinkingLevel,
      transcriptLength: st.transcript.length,
      attachedCount: st.attachedCount,
    });
  }
}
