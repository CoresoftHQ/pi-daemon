// One terminal (spec §5.5): a PTY, the screen the daemon keeps for it, and the clients attached
// to it. Output goes to the screen and to every attached sink; input from any client goes to
// the PTY in arrival order; size is last-resize-wins, coalesced so a rotating phone does not
// make ConPTY repaint forty times.

import { hangupSignal, killTree } from "../os/spawn.ts";
import type { PtyModule, PtyProcess } from "./pty.ts";
import type { Screen } from "./screen.ts";

export type TerminalStatus = "running" | "exited";

export interface TerminalExit {
  code: number | null;
  signal: number | null;
  /** "exited" (on its own), "closed" (DELETE), "shutdown" (the daemon stopped), "failed". */
  reason: "exited" | "closed" | "shutdown" | "failed";
  at: number;
}

export interface TerminalInfo {
  id: string;
  workspaceId: string;
  pid: number;
  cols: number;
  rows: number;
  title: string;
  command: string;
  status: TerminalStatus;
  createdAt: number;
  attachedCount: number;
  exit?: TerminalExit;
}

export interface TerminalSpawn {
  id: string;
  workspaceId: string;
  cwd: string;
  command: string;
  args: string[];
  cols: number;
  rows: number;
  env: Record<string, string>;
  useConpty?: boolean | undefined;
}

export interface TerminalCallbacks {
  onExit: (terminal: Terminal, exit: TerminalExit) => void;
  onTitle: (terminal: Terminal, title: string) => void;
}

export type OutputSink = (data: Buffer) => void;

const RESIZE_COALESCE_MS = 50;

export class Terminal {
  readonly id: string;
  readonly workspaceId: string;
  readonly command: string;
  readonly createdAt: number;
  #pty: PtyProcess;
  #screen: Screen;
  #sinks = new Set<OutputSink>();
  #title = "";
  #exit: TerminalExit | undefined;
  #exitPromise: Promise<TerminalExit>;
  #resolveExit!: (exit: TerminalExit) => void;
  #closing: TerminalExit["reason"] | null = null;
  #pendingResize: { cols: number; rows: number } | null = null;
  #resizeTimer: NodeJS.Timeout | null = null;
  #titleListeners = new Set<(title: string) => void>();
  #resizeListeners = new Set<(cols: number, rows: number) => void>();
  #now: () => number;
  #callbacks: TerminalCallbacks;

  static spawn(
    pty: PtyModule,
    screen: Screen,
    spawn: TerminalSpawn,
    callbacks: TerminalCallbacks,
    now: () => number = Date.now,
  ): Terminal {
    const proc = pty.spawn(spawn.command, spawn.args, {
      name: "xterm-256color",
      cols: spawn.cols,
      rows: spawn.rows,
      cwd: spawn.cwd,
      env: { ...spawn.env, TERM: "xterm-256color", COLORTERM: "truecolor" },
      ...(spawn.useConpty !== undefined ? { useConpty: spawn.useConpty } : {}),
    });
    return new Terminal(proc, screen, spawn, callbacks, now);
  }

  private constructor(
    proc: PtyProcess,
    screen: Screen,
    spawn: TerminalSpawn,
    callbacks: TerminalCallbacks,
    now: () => number,
  ) {
    this.id = spawn.id;
    this.workspaceId = spawn.workspaceId;
    this.command = spawn.command;
    this.createdAt = now();
    this.#pty = proc;
    this.#screen = screen;
    this.#now = now;
    this.#callbacks = callbacks;
    this.#exitPromise = new Promise((resolve) => {
      this.#resolveExit = resolve;
    });
    screen.onTitle((title) => {
      this.#title = title;
      callbacks.onTitle(this, title);
      for (const l of this.#titleListeners) l(title);
    });
    proc.onData((data) => {
      screen.write(data);
      if (this.#sinks.size === 0) return;
      const bytes = Buffer.from(data, "utf8");
      for (const sink of this.#sinks) {
        try {
          sink(bytes);
        } catch {
          /* a sink that throws is a client that is gone; the ws layer removes it */
        }
      }
    });
    proc.onExit(({ exitCode, signal }) => {
      const exit: TerminalExit = {
        code: typeof exitCode === "number" ? exitCode : null,
        signal: typeof signal === "number" && signal !== 0 ? signal : null,
        reason: this.#closing ?? "exited",
        at: this.#now(),
      };
      this.#exit = exit;
      this.#resolveExit(exit);
      callbacks.onExit(this, exit);
    });
  }

  /** Read lazily: on Windows node-pty learns the pid a tick after spawn. */
  get pid(): number {
    return this.#pty.pid;
  }

  get status(): TerminalStatus {
    return this.#exit ? "exited" : "running";
  }

  get exit(): TerminalExit | undefined {
    return this.#exit;
  }

  get title(): string {
    return this.#title;
  }

  get cols(): number {
    return this.#screen.cols;
  }

  get rows(): number {
    return this.#screen.rows;
  }

  get attachedCount(): number {
    return this.#sinks.size;
  }

  info(): TerminalInfo {
    return {
      id: this.id,
      workspaceId: this.workspaceId,
      pid: this.pid,
      cols: this.cols,
      rows: this.rows,
      title: this.#title,
      command: this.command,
      status: this.status,
      createdAt: this.createdAt,
      attachedCount: this.attachedCount,
      ...(this.#exit ? { exit: this.#exit } : {}),
    };
  }

  /** Bytes from a client to the PTY. Interleaved by arrival, like a shared tmux window. */
  write(data: Buffer | string): void {
    if (this.#exit) return;
    this.#pty.write(typeof data === "string" ? data : data.toString("utf8"));
  }

  /** Last resize wins; a burst is applied at most every RESIZE_COALESCE_MS. */
  resize(cols: number, rows: number): void {
    if (this.#exit) return;
    const c = Math.max(2, Math.min(500, Math.trunc(cols)));
    const r = Math.max(1, Math.min(300, Math.trunc(rows)));
    this.#pendingResize = { cols: c, rows: r };
    if (this.#resizeTimer) return;
    this.#applyResize();
    this.#resizeTimer = setTimeout(() => {
      this.#resizeTimer = null;
      if (this.#pendingResize) this.#applyResize();
    }, RESIZE_COALESCE_MS);
  }

  #applyResize(): void {
    const p = this.#pendingResize;
    this.#pendingResize = null;
    if (!p || this.#exit) return;
    if (p.cols === this.cols && p.rows === this.rows) return;
    this.#screen.resize(p.cols, p.rows);
    try {
      this.#pty.resize(p.cols, p.rows);
    } catch {
      /* the PTY may already be gone */
    }
    for (const l of this.#resizeListeners) l(p.cols, p.rows);
  }

  /** Attached clients learn a title or size set by anyone else. */
  onTitle(listener: (title: string) => void): () => void {
    this.#titleListeners.add(listener);
    return () => {
      this.#titleListeners.delete(listener);
    };
  }

  onResize(listener: (cols: number, rows: number) => void): () => void {
    this.#resizeListeners.add(listener);
    return () => {
      this.#resizeListeners.delete(listener);
    };
  }

  /** The screen and scrollback as VT sequences (spec §5.5): what a client replays on attach. */
  snapshot(): Promise<string> {
    return this.#screen.serialize();
  }

  /** Receive live output. Returns the detach function. */
  attach(sink: OutputSink): () => void {
    this.#sinks.add(sink);
    return () => {
      this.#sinks.delete(sink);
    };
  }

  /** Resolves when the process has exited, however that happened. */
  exited(): Promise<TerminalExit> {
    return this.#exitPromise;
  }

  /**
   * Close the PTY (the shell gets SIGHUP), wait a bounded grace, then tree-kill whatever is
   * left — a shell with a stuck child is the common case (spec §9).
   */
  async close(reason: TerminalExit["reason"] = "closed", graceMs = 1500): Promise<TerminalExit> {
    if (this.#exit) return this.#exit;
    this.#closing = reason;
    if (this.#resizeTimer) {
      clearTimeout(this.#resizeTimer);
      this.#resizeTimer = null;
    }
    try {
      this.#pty.kill(hangupSignal());
    } catch {
      /* already gone */
    }
    const exit = await Promise.race([this.#exitPromise, delay(graceMs).then(() => null)]);
    // Whether or not the shell itself has gone, its children may not have: the process group
    // (POSIX) outlives its leader, and taskkill walks what is left of the tree.
    killTree(this.pid);
    if (exit) return exit;
    const forced = await Promise.race([this.#exitPromise, delay(2000).then(() => null)]);
    if (forced) return forced;
    // node-pty never reported; record what we know
    const synthetic: TerminalExit = { code: null, signal: null, reason, at: this.#now() };
    this.#exit = synthetic;
    this.#resolveExit(synthetic);
    this.#callbacks.onExit(this, synthetic);
    return synthetic;
  }

  dispose(): void {
    this.#sinks.clear();
    this.#titleListeners.clear();
    this.#resizeListeners.clear();
    this.#screen.dispose();
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
