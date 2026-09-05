// Filesystem primitives: atomic writes and a directory watch that survives the three
// watchers' different behaviours (spec §9).

import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  watch,
  writeSync,
} from "node:fs";
import { mkdir, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { platform } from "./paths.ts";

export interface AtomicWriteOptions {
  /** File mode for a new file. An existing file keeps its mode unless this is given. */
  mode?: number | undefined;
}

/**
 * Write via a temp file in the same directory, fsync, then rename over the target — so a
 * reader sees the old file or the new one, never a torn one. Preserves an existing file's
 * mode (an executable stays executable).
 */
export function writeFileAtomicSync(
  file: string,
  data: string | Uint8Array,
  options: AtomicWriteOptions = {},
): void {
  const dir = path.dirname(file);
  const tmp = path.join(dir, `.${path.basename(file)}.${randomBytes(6).toString("hex")}.tmp`);
  let mode = options.mode;
  if (mode === undefined) {
    try {
      mode = statSync(file).mode & 0o777;
    } catch {
      /* new file */
    }
  }
  const fd = openSync(tmp, "w", mode ?? 0o644);
  try {
    writeSync(fd, typeof data === "string" ? Buffer.from(data, "utf8") : data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  if (mode !== undefined && platform !== "win32") chmodSync(tmp, mode);
  try {
    renameSync(tmp, file);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* best effort */
    }
    throw err;
  }
}

export function readJsonSync<T>(file: string): T | undefined {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

export function writeJsonAtomicSync(file: string, value: unknown, options: AtomicWriteOptions = {}): void {
  writeFileAtomicSync(file, `${JSON.stringify(value, null, 2)}\n`, options);
}

export async function ensureDir(dir: string, mode?: number): Promise<void> {
  await mkdir(dir, { recursive: true, ...(mode !== undefined ? { mode } : {}) });
}

export interface WatchOptions {
  /** Coalesce bursts into one callback. */
  debounceMs?: number | undefined;
  /** Recursive where the platform supports it natively (macOS, Windows, Linux ≥ 20). */
  recursive?: boolean | undefined;
  /** Polling interval for the fallback when the native watcher fails (inotify limits). */
  pollMs?: number | undefined;
  /** Cap on paths reported per callback; beyond it the list is truncated and `truncated` is set. */
  maxPaths?: number | undefined;
}

export interface WatchEvent {
  /** Relative paths that changed, deduplicated. Empty when only "something changed" is known. */
  paths: string[];
  truncated: boolean;
  /** "native" or "poll" — which mechanism produced this. */
  source: "native" | "poll";
}

export interface DirectoryWatcher {
  close(): void;
  readonly mode: "native" | "poll";
}

/**
 * Watch a directory, debounced and coalesced, with a polling fallback when the native watcher
 * cannot be created (inotify exhaustion is the common case). The contract to callers is the
 * spec's: events may be coalesced or late, never wrong.
 */
export function watchDirectory(
  dir: string,
  onChange: (event: WatchEvent) => void,
  options: WatchOptions = {},
): DirectoryWatcher {
  const debounceMs = options.debounceMs ?? 250;
  const maxPaths = options.maxPaths ?? 500;
  const pending = new Set<string>();
  let truncated = false;
  let timer: NodeJS.Timeout | null = null;
  let source: "native" | "poll" = "native";

  const flush = () => {
    timer = null;
    const paths = [...pending];
    pending.clear();
    const wasTruncated = truncated;
    truncated = false;
    onChange({ paths, truncated: wasTruncated, source });
  };
  const note = (rel: string | null) => {
    if (rel !== null) {
      if (pending.size < maxPaths) pending.add(rel);
      else truncated = true;
    }
    if (!timer) timer = setTimeout(flush, debounceMs);
  };

  // Watch the long, canonical path. On Windows a path containing an 8.3 short name
  // (C:\Users\RUNNER~1\...) trips a libuv assertion in fs-event.c when events arrive with the
  // long name — an abort, not an exception. realpath.native resolves the short name.
  let target = dir;
  try {
    target = realpathSync.native(dir);
  } catch {
    /* does not exist yet; watch() will report that itself */
  }
  try {
    const w = watch(
      target,
      { recursive: options.recursive ?? false, persistent: false },
      (_type, filename) => {
        note(filename ? String(filename) : null);
      },
    );
    w.on("error", () => {
      /* fall through to polling below on next tick */
    });
    return {
      close: () => {
        w.close();
        if (timer) clearTimeout(timer);
      },
      mode: "native",
    };
  } catch {
    source = "poll";
  }

  // Polling fallback: shallow mtime scan.
  const pollMs = options.pollMs ?? 2000;
  let last = new Map<string, number>();
  let closed = false;
  const scan = async () => {
    if (closed) return;
    try {
      const entries = await readdir(dir);
      const next = new Map<string, number>();
      for (const e of entries) {
        try {
          next.set(e, (await stat(path.join(dir, e))).mtimeMs);
        } catch {
          /* vanished mid-scan */
        }
      }
      for (const [k, v] of next) if (last.get(k) !== v) note(k);
      for (const k of last.keys()) if (!next.has(k)) note(k);
      last = next;
    } catch {
      /* directory gone; report nothing */
    }
    if (!closed) setTimeout(scan, pollMs).unref();
  };
  void scan();
  return {
    close: () => {
      closed = true;
      if (timer) clearTimeout(timer);
    },
    mode: "poll",
  };
}

export function fileExists(p: string): boolean {
  return existsSync(p);
}
