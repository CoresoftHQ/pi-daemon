// One session: canonical state, its runner when live, and the mapping from operations to pi's
// RPC vocabulary (spec §2.1, §8). Knows nothing about connections or wire formats.

import { EventEmitter } from "node:events";
import type { Launcher } from "../os/spawn.ts";
import type { ExtensionUiRequest, ExtensionUiResponse, RpcState, ThinkingLevel } from "../runners/rpc.ts";
import type { RunnerExit, RunnerSpawnOptions } from "../runners/runner.ts";
import { Runner, RunnerExitedError } from "../runners/runner.ts";
import type { ClosedDialog, DialogTable, PendingDialog, RespondResult } from "./dialogs.ts";
import { Projector } from "./projector.ts";
import type { Interrupted, Progress, SessionState } from "./state.ts";

export interface SessionSpawnConfig {
  cwd: string;
  workspaceId: string;
  /** Already scrubbed of daemon secrets by the host. */
  env: NodeJS.ProcessEnv;
  launcher?: Launcher | undefined;
  extensions?: readonly string[] | undefined;
  isolate?: boolean | undefined;
  tools?: readonly string[] | undefined;
  excludeTools?: readonly string[] | undefined;
  noTools?: boolean | undefined;
  trust?: "approve" | "no-approve" | undefined;
  sessionDir?: string | undefined;
  /** Explicit session file to open instead of resolving by id (a re-homed session, spec §11.9). */
  sessionFile?: string | undefined;
}

export interface SessionEvents {
  snapshot: [SessionState];
  progress: [Progress];
  run_started: [string];
  run_settled: [string];
  dialog_opened: [PendingDialog];
  dialog_closed: [ClosedDialog];
  notice: [ExtensionUiRequest];
  interrupted: [Interrupted];
  runner_exited: [RunnerExit];
  live: [boolean];
}

export class SessionBusyError extends Error {
  constructor() {
    super("session is streaming; use steer or follow_up");
    this.name = "SessionBusyError";
  }
}

export class SessionNotLiveError extends Error {
  constructor(id: string) {
    super(`session ${id} has no runner; attach first`);
    this.name = "SessionNotLiveError";
  }
}

export interface PromptResult {
  /** The run this prompt started, when it started one. */
  runId?: string;
  /** True when the prompt was queued behind a running turn. */
  queued: boolean;
}

export interface SessionDeps {
  dialogs: DialogTable;
  mintRunId: () => string;
  now?: (() => number) | undefined;
  /** How long to wait for pi's agent_start after a prompt is accepted. */
  runStartTimeoutMs?: number | undefined;
}

export class Session extends EventEmitter<SessionEvents> {
  readonly id: string;
  readonly projector: Projector;
  readonly config: SessionSpawnConfig;
  lastActivityAt: number;
  readonly #deps: SessionDeps;
  #runner: Runner | null = null;
  #now: () => number;

  private constructor(id: string, config: SessionSpawnConfig, deps: SessionDeps, projector: Projector) {
    super();
    this.id = id;
    this.config = config;
    this.#deps = deps;
    this.projector = projector;
    this.#now = deps.now ?? Date.now;
    this.lastActivityAt = this.#now();
  }

  get state(): SessionState {
    return this.projector.state;
  }

  get live(): boolean {
    return this.#runner !== null && !this.#runner.exited;
  }

  get runnerPid(): number | undefined {
    return this.#runner?.pid;
  }

  /** Spawn a runner for a brand-new session. */
  static async create(config: SessionSpawnConfig, deps: SessionDeps): Promise<Session> {
    const runner = Session.#spawn(config, undefined);
    try {
      const state = await Session.#stateOf(runner);
      const projector = new Projector({
        sessionId: state.sessionId,
        workspaceId: config.workspaceId,
        cwd: config.cwd,
        mintRunId: deps.mintRunId,
        now: deps.now,
      });
      projector.applyState(state);
      const session = new Session(state.sessionId, config, deps, projector);
      session.#adopt(runner);
      return session;
    } catch (err) {
      runner.kill();
      throw err;
    }
  }

  /** Open an existing session by id (or by file, when config.sessionFile is set). */
  static async open(
    id: string,
    config: SessionSpawnConfig,
    deps: SessionDeps,
    createdAt?: number,
  ): Promise<Session> {
    const projector = new Projector({
      sessionId: id,
      workspaceId: config.workspaceId,
      cwd: config.cwd,
      mintRunId: deps.mintRunId,
      now: deps.now,
      createdAt,
    });
    const session = new Session(id, config, deps, projector);
    await session.ensureLive();
    return session;
  }

  static #spawn(config: SessionSpawnConfig, session: string | undefined): Runner {
    const options: RunnerSpawnOptions = {
      cwd: config.cwd,
      env: config.env,
      launcher: config.launcher,
      extensions: config.extensions,
      isolate: config.isolate,
      tools: config.tools,
      excludeTools: config.excludeTools,
      noTools: config.noTools,
      trust: config.trust,
      sessionDir: config.sessionDir,
      session,
    };
    return Runner.spawn(options);
  }

  static async #stateOf(runner: Runner): Promise<RpcState> {
    const res = await runner.send<RpcState>({ type: "get_state" });
    if (!res.success || !res.data) throw new Error(`get_state failed: ${res.error ?? "no data"}`);
    return res.data;
  }

  /** Respawn the runner from the session file if it is not live (eviction, crash, restart). */
  async ensureLive(): Promise<void> {
    if (this.live) return;
    const runner = Session.#spawn(this.config, this.config.sessionFile ?? this.id);
    try {
      const state = await Session.#stateOf(runner);
      if (state.sessionId !== this.id)
        throw new Error(`runner opened session ${state.sessionId}, expected ${this.id}`);
      this.projector.applyState(state);
      const entries = await runner.send<{ entries: unknown[] }>({ type: "get_entries" });
      if (entries.success && entries.data) this.projector.loadEntries(entries.data.entries);
      else {
        const msgs = await runner.send<{ messages: unknown[] }>({ type: "get_messages" });
        this.projector.loadMessages(msgs.data?.messages ?? []);
      }
    } catch (err) {
      runner.kill();
      throw err;
    }
    this.#adopt(runner);
    this.emit("snapshot", this.state);
  }

  #adopt(runner: Runner): void {
    this.#runner = runner;
    this.projector.setLive(true);
    this.touch();
    runner.on("event", (ev) => {
      if (this.#runner !== runner) return;
      this.touch();
      const out = this.projector.apply(ev);
      for (const p of out.progress) this.emit("progress", p);
      if (out.runStarted) this.emit("run_started", out.runStarted);
      if (out.snapshot) this.emit("snapshot", this.state);
      if (out.runSettled !== undefined) this.emit("run_settled", out.runSettled);
    });
    runner.on("ui_request", (req) => {
      if (this.#runner !== runner) return;
      const dialog = this.#deps.dialogs.open(this.id, req);
      if (dialog.blocking) this.emit("dialog_opened", dialog);
      else this.emit("notice", req);
    });
    runner.once("exit", (exit) => {
      if (this.#runner !== runner) return;
      this.#runner = null;
      if (!exit.expected) {
        this.projector.markInterrupted("runner_crashed", exit.stderrTail.trim().slice(-500) || undefined);
        if (this.state.interrupted) this.emit("interrupted", this.state.interrupted);
      }
      for (const d of this.#deps.dialogs.closeAllForSession(this.id)) this.emit("dialog_closed", d);
      this.projector.setLive(false);
      this.emit("live", false);
      this.emit("runner_exited", exit);
      this.emit("snapshot", this.state);
    });
    this.emit("live", true);
  }

  touch(): void {
    this.lastActivityAt = this.#now();
  }

  #need(): Runner {
    if (!this.#runner || this.#runner.exited) throw new SessionNotLiveError(this.id);
    return this.#runner;
  }

  async #rpc<T>(command: Parameters<Runner["send"]>[0]): Promise<T | undefined> {
    const runner = this.#need();
    this.touch();
    const res = await runner.send<T>(command);
    if (!res.success) {
      if (/streaming|busy/i.test(res.error ?? "")) throw new SessionBusyError();
      throw new Error(res.error ?? `${command.type} failed`);
    }
    return res.data;
  }

  /**
   * Send a prompt. Idle: starts a run and resolves with its runId once pi reports agent_start.
   * Streaming: queued as steer or follow-up per `during`, resolving with queued: true.
   */
  async prompt(
    text: string,
    options: { during?: "steer" | "followUp" | undefined } = {},
  ): Promise<PromptResult> {
    const runner = this.#need();
    if (this.state.phase !== "idle") {
      if (!options.during) throw new SessionBusyError();
      await this.#rpc({ type: "prompt", message: text, streamingBehavior: options.during });
      return { queued: true };
    }
    const started = new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error("pi accepted the prompt but did not start a run"));
      }, this.#deps.runStartTimeoutMs ?? 10_000);
      const onStart = (runId: string) => {
        cleanup();
        resolve(runId);
      };
      const onExit = () => {
        cleanup();
        reject(new RunnerExitedError());
      };
      const cleanup = () => {
        clearTimeout(timeout);
        this.off("run_started", onStart);
        runner.off("exit", onExit);
      };
      this.once("run_started", onStart);
      runner.once("exit", onExit);
    });
    started.catch(() => {});
    await this.#rpc({ type: "prompt", message: text });
    delete this.state.interrupted;
    return { runId: await started, queued: false };
  }

  steer(text: string): Promise<void> {
    return this.#rpc({ type: "steer", message: text }).then(() => undefined);
  }

  followUp(text: string): Promise<void> {
    return this.#rpc({ type: "follow_up", message: text }).then(() => undefined);
  }

  abort(): Promise<void> {
    return this.#rpc({ type: "abort" }).then(() => undefined);
  }

  async setModel(provider: string, modelId: string): Promise<void> {
    await this.#rpc({ type: "set_model", provider, modelId });
    await this.#refreshState();
  }

  async setThinking(level: ThinkingLevel): Promise<void> {
    await this.#rpc({ type: "set_thinking_level", level });
    await this.#refreshState();
  }

  async setName(name: string): Promise<void> {
    await this.#rpc({ type: "set_session_name", name });
    await this.#refreshState();
  }

  compact(customInstructions?: string): Promise<void> {
    return this.#rpc({ type: "compact", ...(customInstructions ? { customInstructions } : {}) }).then(
      () => undefined,
    );
  }

  getEntries(since?: string): Promise<{ entries: unknown[]; leafId: string | null } | undefined> {
    return this.#rpc({ type: "get_entries", ...(since ? { since } : {}) });
  }

  getStats(): Promise<unknown> {
    return this.#rpc({ type: "get_session_stats" });
  }

  async #refreshState(): Promise<void> {
    const state = await this.#rpc<RpcState>({ type: "get_state" });
    if (state) {
      this.projector.applyState(state);
      this.emit("snapshot", this.state);
    }
  }

  /** Relay a client's answer. First answer wins; a dead runner closes the dialog instead. */
  respondDialog(dialogId: string, response: ExtensionUiResponse, answeredBy: string): RespondResult {
    const pending = this.#deps.dialogs.get(dialogId);
    if (!pending) return this.#deps.dialogs.respond(dialogId, response, answeredBy);
    const delivered = this.#runner?.respondUi(pending.request.id, response) ?? false;
    if (!delivered) {
      for (const d of this.#deps.dialogs.closeAllForSession(this.id, "runner_exited"))
        this.emit("dialog_closed", d);
      return { ok: false, reason: "already-resolved", resolution: "runner_exited" };
    }
    const result = this.#deps.dialogs.respond(dialogId, response, answeredBy);
    if (result.ok) this.emit("dialog_closed", result.dialog);
    return result;
  }

  /** Stop the runner; the session stays listable and rehydrates on the next attach. */
  async evict(reason: "idle" | "cap" | "shutdown" = "idle"): Promise<void> {
    const runner = this.#runner;
    if (!runner || runner.exited) return;
    const midTurn = this.state.phase !== "idle";
    this.#runner = null;
    await runner.stop({ graceMs: reason === "shutdown" ? 10_000 : 3000 });
    if (midTurn) {
      this.projector.markInterrupted("evicted_mid_turn", reason);
      if (this.state.interrupted) this.emit("interrupted", this.state.interrupted);
    }
    for (const d of this.#deps.dialogs.closeAllForSession(this.id)) this.emit("dialog_closed", d);
    this.projector.setLive(false);
    this.emit("live", false);
    this.emit("snapshot", this.state);
  }

  /** Kill the runner immediately (tests, and the last resort on shutdown). */
  kill(): void {
    const runner = this.#runner;
    this.#runner = null;
    runner?.kill();
    this.projector.setLive(false);
  }
}
