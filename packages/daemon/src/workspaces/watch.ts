// One watcher per registered workspace, feeding two consumers: git-status cache invalidation and
// the `workspace.files_changed` event (spec §5.4). Recursive watching is native on macOS,
// Windows, and Linux ≥ 20; when the native watcher cannot be created the os module polls, and
// `touch` lets a listing add the directory a client is looking at to that polled set.

import path from "node:path";
import type { DirectoryWatcher, WatchEvent } from "../os/fsx.ts";
import { watchDirectory } from "../os/fsx.ts";
import type { Logger } from "../os/log.ts";

export interface FilesChanged {
  workspaceId: string;
  /** Relative, forward slashes, deduplicated, bounded. */
  paths: string[];
  truncated: boolean;
}

export interface WorkspaceWatchersOptions {
  onChange: (change: FilesChanged) => void;
  debounceMs?: number | undefined;
  pollMs?: number | undefined;
  maxPaths?: number | undefined;
  log?: Logger | undefined;
}

interface Watched {
  root: string;
  main: DirectoryWatcher;
  /** Extra non-recursive watchers for listed directories when `main` is polling. */
  extra: Map<string, DirectoryWatcher>;
}

export class WorkspaceWatchers {
  readonly #o: WorkspaceWatchersOptions;
  readonly #watched = new Map<string, Watched>();

  constructor(options: WorkspaceWatchersOptions) {
    this.#o = options;
  }

  watch(workspaceId: string, root: string): void {
    if (this.#watched.has(workspaceId)) return;
    const main = watchDirectory(root, (ev) => this.#emit(workspaceId, root, "", ev), {
      recursive: true,
      debounceMs: this.#o.debounceMs ?? 250,
      pollMs: this.#o.pollMs ?? 2000,
      maxPaths: this.#o.maxPaths ?? 200,
    });
    this.#watched.set(workspaceId, { root, main, extra: new Map() });
    this.#o.log?.debug?.("workspace watch", { workspaceId, mode: main.mode });
  }

  unwatch(workspaceId: string): void {
    const w = this.#watched.get(workspaceId);
    if (!w) return;
    w.main.close();
    for (const x of w.extra.values()) x.close();
    this.#watched.delete(workspaceId);
  }

  mode(workspaceId: string): "native" | "poll" | undefined {
    return this.#watched.get(workspaceId)?.main.mode;
  }

  /** A client listed this directory: when the main watcher is polling, watch it directly too. */
  touch(workspaceId: string, relDir: string): void {
    const w = this.#watched.get(workspaceId);
    if (!w || w.main.mode !== "poll" || w.extra.has(relDir) || w.extra.size >= 64) return;
    const dir = path.join(w.root, relDir);
    const watcher = watchDirectory(dir, (ev) => this.#emit(workspaceId, w.root, relDir, ev), {
      recursive: false,
      debounceMs: this.#o.debounceMs ?? 250,
      pollMs: this.#o.pollMs ?? 2000,
      maxPaths: this.#o.maxPaths ?? 200,
    });
    w.extra.set(relDir, watcher);
  }

  close(): void {
    for (const id of [...this.#watched.keys()]) this.unwatch(id);
  }

  #emit(workspaceId: string, _root: string, prefix: string, ev: WatchEvent): void {
    const seen = new Set<string>();
    for (const p of ev.paths) {
      const rel = (prefix ? `${prefix}/${p}` : p).split(path.sep).join("/");
      if (rel === ".git" || rel.startsWith(".git/")) continue;
      seen.add(rel);
    }
    // .git-internal churn is not a file change to a client, but the status cache still wants to
    // hear about it: an empty, untruncated change means "invalidate, do not publish".
    this.#o.onChange({ workspaceId, paths: [...seen].sort(), truncated: ev.truncated });
  }
}
