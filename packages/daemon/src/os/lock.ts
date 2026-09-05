// Single-instance lock (spec §9): a lockfile taken by exclusive create, holding pid and port.
// Liveness is confirmed by probing the port, not by trusting the pid, because pid reuse
// semantics differ across platforms.

import { closeSync, openSync, unlinkSync, writeSync } from "node:fs";
import { readJsonSync } from "./fsx.ts";
import { pidAlive } from "./spawn.ts";

export interface LockInfo {
  pid: number;
  port: number;
  startedAt: number;
}

export class LockHeldError extends Error {
  readonly holder: LockInfo;
  constructor(holder: LockInfo) {
    super(`another instance is running (pid ${holder.pid}, port ${holder.port})`);
    this.name = "LockHeldError";
    this.holder = holder;
  }
}

export interface Lock {
  readonly file: string;
  readonly info: LockInfo;
  release(): void;
}

export interface AcquireLockOptions {
  /** Is the holder actually serving? Called with the recorded port. */
  probe: (holder: LockInfo) => Promise<boolean>;
}

function tryCreate(file: string, info: LockInfo): boolean {
  let fd: number;
  try {
    fd = openSync(file, "wx", 0o600);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
  try {
    writeSync(fd, `${JSON.stringify(info)}\n`);
  } finally {
    closeSync(fd);
  }
  return true;
}

/**
 * Take the lock, or throw LockHeldError with the live holder. A stale lock — holder not
 * answering on its port and its pid gone — is removed and retaken.
 */
export async function acquireLock(file: string, info: LockInfo, options: AcquireLockOptions): Promise<Lock> {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (tryCreate(file, info)) {
      return {
        file,
        info,
        release() {
          try {
            unlinkSync(file);
          } catch {
            /* already gone */
          }
        },
      };
    }
    let existing: LockInfo | undefined;
    try {
      existing = readJsonSync<LockInfo>(file);
    } catch {
      existing = undefined; // unreadable: treated as stale below
    }
    if (existing && typeof existing.pid === "number" && typeof existing.port === "number") {
      const serving = await options.probe(existing).catch(() => false);
      if (serving || pidAlive(existing.pid)) throw new LockHeldError(existing);
    }
    // Stale or unreadable: clear it and try again.
    try {
      unlinkSync(file);
    } catch {
      /* raced with another starter */
    }
  }
  throw new Error(`could not acquire lock ${file}`);
}
