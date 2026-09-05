// A Runner is one supervised `pi --mode rpc` process: one live session (spec §2.1).
//
// It owns the child, the JSONL framing, command correlation, and the lifecycle — graceful stop,
// then tree-kill; crash detection with a stderr tail. It knows nothing about snapshots, clients,
// or policy; `sessions` builds those on top.

import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import type { Launcher } from "../os/spawn.ts";
import { killTree, resolvePiLauncher, spawnArgv } from "../os/spawn.ts";
import { createJsonlSplitter, encodeJsonl } from "./jsonl.ts";
import type { ExtensionUiRequest, ExtensionUiResponse, RpcCommand, RpcEvent, RpcResponse } from "./rpc.ts";

export interface RunnerSpawnOptions {
  /** The workspace. RPC mode has no --cwd flag; the working directory *is* the confinement. */
  cwd: string;
  /** Resume an existing session by id or by explicit file path (spec §11.9). */
  session?: string | undefined;
  /** Custom session store. The daemon normally leaves this unset so terminal `pi` sees the same sessions. */
  sessionDir?: string | undefined;
  noSession?: boolean | undefined;
  /** Extensions to load with -e; each is a path, npm name, or git source. */
  extensions?: readonly string[] | undefined;
  /** Disable discovery of the operator's extensions, skills, prompts, themes, and context files. */
  isolate?: boolean | undefined;
  tools?: readonly string[] | undefined;
  excludeTools?: readonly string[] | undefined;
  noTools?: boolean | undefined;
  /** Project trust for this run: -a / -na. Unset lets pi apply the operator's default (spec §7.4). */
  trust?: "approve" | "no-approve" | undefined;
  model?: string | undefined;
  name?: string | undefined;
  extraArgs?: readonly string[] | undefined;
  /** Already scrubbed by the caller; passed through unchanged. */
  env?: NodeJS.ProcessEnv | undefined;
  /** How to start pi. Defaults to resolvePiLauncher(); tests point it at a fake. */
  launcher?: Launcher | undefined;
  /** How much stderr to keep for crash reports. */
  stderrTailBytes?: number | undefined;
}

export type RunnerState = "starting" | "running" | "stopping" | "exited";

export interface RunnerExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** True when the daemon asked for this exit; false means a crash. */
  expected: boolean;
  stderrTail: string;
}

export interface RunnerEvents {
  event: [RpcEvent];
  ui_request: [ExtensionUiRequest];
  stderr: [string];
  protocol_error: [Error, string];
  exit: [RunnerExit];
}

export class RunnerExitedError extends Error {
  constructor(message = "runner has exited") {
    super(message);
    this.name = "RunnerExitedError";
  }
}

export class PiNotFoundError extends Error {
  constructor() {
    super("pi was not found on PATH and PI_DAEMON_PI is not set");
    this.name = "PiNotFoundError";
  }
}

/**
 * Every live runner, so that when this process exits — cleanly, by signal, or by a test
 * runner's force-exit — no pi process is orphaned. killTree is synchronous on both platforms,
 * which is what an exit hook needs.
 */
const liveRunners = new Set<Runner>();
let exitHookInstalled = false;
function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once("exit", () => {
    for (const r of liveRunners) if (r.pid) killTree(r.pid);
  });
}

export function buildArgs(options: RunnerSpawnOptions): string[] {
  const args = ["--mode", "rpc"];
  if (options.isolate)
    args.push("--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files");
  for (const e of options.extensions ?? []) args.push("-e", e);
  if (options.noTools) args.push("--no-tools");
  if (options.tools?.length) args.push("--tools", options.tools.join(","));
  if (options.excludeTools?.length) args.push("--exclude-tools", options.excludeTools.join(","));
  if (options.trust === "approve") args.push("--approve");
  if (options.trust === "no-approve") args.push("--no-approve");
  if (options.sessionDir) args.push("--session-dir", options.sessionDir);
  if (options.noSession) args.push("--no-session");
  if (options.session) args.push("--session", options.session);
  if (options.model) args.push("--model", options.model);
  if (options.name) args.push("--name", options.name);
  args.push(...(options.extraArgs ?? []));
  return args;
}

export class Runner extends EventEmitter<RunnerEvents> {
  readonly cwd: string;
  readonly args: readonly string[];
  readonly startedAt: number;
  readonly #child: ChildProcess;
  readonly #pending = new Map<string, { resolve: (r: RpcResponse) => void; reject: (e: Error) => void }>();
  readonly #stderrTailBytes: number;
  #stderrTail = "";
  #seq = 0;
  #state: RunnerState = "starting";
  #expectedExit = false;
  #exit: RunnerExit | null = null;

  private constructor(child: ChildProcess, options: RunnerSpawnOptions, args: string[]) {
    super();
    this.cwd = options.cwd;
    this.args = args;
    this.startedAt = Date.now();
    this.#child = child;
    this.#stderrTailBytes = options.stderrTailBytes ?? 8192;

    const splitter = createJsonlSplitter(
      (record) => this.#onRecord(record),
      (err, line) => this.emit("protocol_error", err, line),
    );
    child.stdout?.on("data", (chunk: Buffer) => splitter.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      this.#stderrTail = (this.#stderrTail + text).slice(-this.#stderrTailBytes);
      this.emit("stderr", text);
    });
    child.stdin?.on("error", () => {
      /* EPIPE on a dying child; the exit handler reports it */
    });
    child.once("spawn", () => {
      if (this.#state === "starting") this.#state = "running";
    });
    child.once("error", (err) => {
      // Failed to spawn at all (ENOENT etc.). Report as an unexpected exit.
      this.#stderrTail = (this.#stderrTail + err.message).slice(-this.#stderrTailBytes);
      this.#finish(null, null);
    });
    child.once("exit", (code, signal) => this.#finish(code, signal));
  }

  /** Spawn pi. Throws PiNotFoundError synchronously when no launcher can be resolved. */
  static spawn(options: RunnerSpawnOptions): Runner {
    const launcher = options.launcher ?? resolvePiLauncher(options.env ?? process.env);
    if (!launcher) throw new PiNotFoundError();
    const args = buildArgs(options);
    const child = spawnArgv(launcher.command, [...launcher.prefix, ...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: "pipe",
      ownGroup: true,
    });
    const runner = new Runner(child, options, args);
    liveRunners.add(runner);
    installExitHook();
    return runner;
  }

  get pid(): number | undefined {
    return this.#child.pid;
  }

  get state(): RunnerState {
    return this.#state;
  }

  get exited(): boolean {
    return this.#state === "exited";
  }

  get exitInfo(): RunnerExit | null {
    return this.#exit;
  }

  #finish(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.#state === "exited") return;
    this.#state = "exited";
    liveRunners.delete(this);
    const exit: RunnerExit = { code, signal, expected: this.#expectedExit, stderrTail: this.#stderrTail };
    this.#exit = exit;
    for (const [, p] of this.#pending)
      p.reject(new RunnerExitedError(`runner exited (${code ?? signal}) before responding`));
    this.#pending.clear();
    this.emit("exit", exit);
  }

  #onRecord(record: unknown): void {
    if (!record || typeof record !== "object") return;
    const r = record as { type?: unknown; id?: unknown };
    if (r.type === "response" && typeof r.id === "string") {
      const p = this.#pending.get(r.id);
      if (p) {
        this.#pending.delete(r.id);
        p.resolve(record as RpcResponse);
        return;
      }
    }
    if (r.type === "extension_ui_request") {
      this.emit("ui_request", record as ExtensionUiRequest);
      return;
    }
    if (typeof r.type === "string") this.emit("event", record as RpcEvent);
  }

  /** Returns false when the child is gone. Writing to a dead runner is a normal race, never a throw. */
  #write(value: unknown): boolean {
    if (this.#state === "exited") return false;
    const stdin = this.#child.stdin;
    if (!stdin?.writable) return false;
    stdin.write(encodeJsonl(value));
    return true;
  }

  /** Send one command and await its correlated response. Rejects with RunnerExitedError if the runner dies first. */
  send<T = unknown>(command: RpcCommand): Promise<RpcResponse<T>> {
    const id = `c${++this.#seq}`;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve: resolve as (r: RpcResponse) => void, reject });
      if (!this.#write({ id, ...command })) {
        this.#pending.delete(id);
        reject(new RunnerExitedError());
      }
    });
  }

  /** Answer an extension_ui_request. False means the runner died first — the dialog died with it. */
  respondUi(id: string, response: ExtensionUiResponse): boolean {
    return this.#write({ type: "extension_ui_response", id, ...response });
  }

  /** Resolve with the next event of the given type, or reject after timeoutMs. */
  waitForEvent(type: string, timeoutMs = 60_000): Promise<RpcEvent> {
    return new Promise((resolve, reject) => {
      if (this.#state === "exited") return reject(new RunnerExitedError());
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`timed out after ${timeoutMs} ms waiting for ${type}`));
      }, timeoutMs);
      const onEvent = (e: RpcEvent) => {
        if (e.type === type) {
          cleanup();
          resolve(e);
        }
      };
      const onExit = () => {
        cleanup();
        reject(new RunnerExitedError());
      };
      const cleanup = () => {
        clearTimeout(timer);
        this.off("event", onEvent);
        this.off("exit", onExit);
      };
      this.on("event", onEvent);
      this.once("exit", onExit);
    });
  }

  /**
   * Stop gracefully: close stdin (pi exits on EOF), wait up to graceMs, then kill the whole
   * process tree. Resolves with the exit either way.
   */
  stop(options: { graceMs?: number } = {}): Promise<RunnerExit> {
    const graceMs = options.graceMs ?? 5000;
    if (this.#exit) return Promise.resolve(this.#exit);
    this.#expectedExit = true;
    this.#state = "stopping";
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.kill();
      }, graceMs);
      this.once("exit", (exit) => {
        clearTimeout(timer);
        resolve(exit);
      });
      try {
        this.#child.stdin?.end();
      } catch {
        this.kill();
      }
    });
  }

  /** Kill the runner and everything under it, now. */
  kill(): void {
    if (this.#state === "exited") return;
    this.#expectedExit = true;
    this.#state = "stopping";
    if (this.#child.pid) killTree(this.#child.pid);
  }
}
