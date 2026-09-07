// Terminals as a set (spec §5.5): the operator's switch, the addon's availability, the cap, and
// the `terminal.*` events. Publishes through a callback so this module never knows the event
// log, and knows the workspace only as an id and a directory.

import { scrubEnvStrings } from "../os/env.ts";
import { crockfordId } from "../os/ids.ts";
import type { Logger } from "../os/log.ts";
import { userShell } from "../os/spawn.ts";
import type { PtyLoader, PtyModule, PtyStatus } from "./pty.ts";
import { loadPty } from "./pty.ts";
import type { Screen, ScreenOptions } from "./screen.ts";
import { createScreen } from "./screen.ts";
import type { TerminalExit, TerminalInfo } from "./terminal.ts";
import { Terminal } from "./terminal.ts";

export type TerminalScope = `terminal:${string}` | `workspace:${string}`;
export type Publish = (scope: TerminalScope, type: string, payload: unknown) => void;

export class TerminalsDisabledError extends Error {
  constructor() {
    super("terminals are switched off on this daemon (terminals: false)");
    this.name = "TerminalsDisabledError";
  }
}
export class TerminalsUnavailableError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "TerminalsUnavailableError";
  }
}
export class TerminalCapError extends Error {
  constructor(max: number) {
    super(`maxTerminals (${max}) reached; close one first`);
    this.name = "TerminalCapError";
  }
}
export class TerminalNotFoundError extends Error {
  constructor(id: string) {
    super(`unknown terminal ${id}`);
    this.name = "TerminalNotFoundError";
  }
}

export interface TerminalManagerOptions {
  publish: Publish;
  /** The operator's switch. */
  enabled?: boolean | undefined;
  maxTerminals?: number | undefined;
  scrollbackLines?: number | undefined;
  /** The daemon's environment; scrubbed before any shell sees it. */
  env?: NodeJS.ProcessEnv | undefined;
  loader?: PtyLoader | undefined;
  screenFactory?: ((options: ScreenOptions) => Screen) | undefined;
  now?: (() => number) | undefined;
  log?: Logger | undefined;
}

export interface CreateTerminalParams {
  workspaceId: string;
  cwd: string;
  cols: number;
  rows: number;
  /** Something other than the shell. An array, never a string (spec §9). */
  argv?: string[] | undefined;
}

export class TerminalManager {
  /** Both operator settings, flipped at runtime by `pi-daemon config` (M8). */
  maxTerminals: number;
  enabled: boolean;
  readonly scrollbackLines: number;
  readonly #o: TerminalManagerOptions;
  readonly #terminals = new Map<string, Terminal>();
  readonly #now: () => number;
  #pty: { status: PtyStatus; module: PtyModule | null } | undefined;

  constructor(options: TerminalManagerOptions) {
    this.#o = options;
    this.enabled = options.enabled ?? true;
    this.maxTerminals = options.maxTerminals ?? 16;
    this.scrollbackLines = options.scrollbackLines ?? 10_000;
    this.#now = options.now ?? Date.now;
  }

  /** Loads the addon on first call and remembers the outcome. */
  status(): PtyStatus {
    if (!this.#pty) this.#pty = loadPty(this.#o.loader);
    return this.#pty.status;
  }

  /** What `capabilities` says: `terminals` in features, or in absent with the reason. */
  capability(): { feature: boolean; reason: string | null } {
    if (!this.enabled) return { feature: false, reason: "terminals: false" };
    const s = this.status();
    return s.available ? { feature: true, reason: null } : { feature: false, reason: s.error };
  }

  /** Resolves once the process exists (node-pty on Windows starts it a tick after spawn). */
  async create(params: CreateTerminalParams): Promise<Terminal> {
    if (!this.enabled) throw new TerminalsDisabledError();
    const pty = this.status();
    const module = this.#pty?.module;
    if (!pty.available || !module) throw new TerminalsUnavailableError(pty.error ?? "PTY addon did not load");
    const running = [...this.#terminals.values()].filter((t) => t.status === "running").length;
    if (running >= this.maxTerminals) throw new TerminalCapError(this.maxTerminals);

    const env = scrubEnvStrings(this.#o.env ?? process.env);
    const shell = userShell(env);
    const [command, ...args] =
      params.argv && params.argv.length > 0 ? params.argv : [shell.command, ...shell.interactiveArgs];
    if (!command) throw new TerminalsUnavailableError("no shell to run");
    const cols = clamp(params.cols, 2, 500, 80);
    const rows = clamp(params.rows, 1, 300, 24);
    const id = `tm_${crockfordId(8)}`;
    const screen = (this.#o.screenFactory ?? createScreen)({ cols, rows, scrollback: this.scrollbackLines });
    let terminal: Terminal;
    try {
      terminal = Terminal.spawn(
        module,
        screen,
        { id, workspaceId: params.workspaceId, cwd: params.cwd, command, args, cols, rows, env },
        {
          onExit: (t, exit) => this.#onExit(t, exit),
          onTitle: (t, title) =>
            this.#o.publish(`terminal:${t.id}`, "terminal.title", { terminalId: t.id, title }),
        },
        this.#now,
      );
    } catch (err) {
      screen.dispose();
      throw new TerminalsUnavailableError(
        `PTY spawn failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    this.#terminals.set(id, terminal);
    // ConPTY reports the pid once the process is connected, not at spawn: wait for it, bounded.
    for (let i = 0; i < 200 && terminal.pid === 0 && terminal.status === "running"; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    this.#o.log?.info("terminal opened", {
      terminalId: id,
      workspaceId: params.workspaceId,
      pid: terminal.pid,
      command,
    });
    this.#o.publish(`workspace:${params.workspaceId}`, "terminal.created", { terminal: terminal.info() });
    return terminal;
  }

  get(id: string): Terminal | undefined {
    return this.#terminals.get(id);
  }

  require(id: string): Terminal {
    const t = this.#terminals.get(id);
    if (!t) throw new TerminalNotFoundError(id);
    return t;
  }

  list(workspaceId?: string): TerminalInfo[] {
    return [...this.#terminals.values()]
      .filter((t) => !workspaceId || t.workspaceId === workspaceId)
      .map((t) => t.info());
  }

  /** True when any terminal in the workspace is still running (blocks worktree removal). */
  busy(workspaceId: string): boolean {
    return [...this.#terminals.values()].some((t) => t.workspaceId === workspaceId && t.status === "running");
  }

  async close(id: string, graceMs?: number): Promise<TerminalExit> {
    const t = this.require(id);
    const exit = await t.close("closed", graceMs);
    this.#forget(t);
    return exit;
  }

  /** Forget an exited terminal (its record stays until then so a client can read the exit). */
  remove(id: string): boolean {
    const t = this.#terminals.get(id);
    if (!t || t.status !== "exited") return false;
    this.#forget(t);
    return true;
  }

  async closeAll(reason: TerminalExit["reason"] = "shutdown", graceMs = 1000): Promise<void> {
    const all = [...this.#terminals.values()];
    await Promise.all(all.map((t) => t.close(reason, graceMs).catch(() => undefined)));
    for (const t of all) this.#forget(t);
  }

  #onExit(t: Terminal, exit: TerminalExit): void {
    t.releasePty();
    this.#o.log?.info("terminal exited", {
      terminalId: t.id,
      code: exit.code,
      signal: exit.signal,
      reason: exit.reason,
    });
    this.#o.publish(`workspace:${t.workspaceId}`, "terminal.exited", {
      terminalId: t.id,
      workspaceId: t.workspaceId,
      ...exit,
    });
  }

  #forget(t: Terminal): void {
    t.dispose();
    this.#terminals.delete(t.id);
  }
}

function clamp(n: number | undefined, min: number, max: number, dflt: number): number {
  if (typeof n !== "number" || !Number.isFinite(n)) return dflt;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}
