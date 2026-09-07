// The one native addon, loaded lazily and behind a capability (spec §2.2, §5.5). This is the
// only file in the daemon allowed to know node-pty exists. Several packages provide the same
// API with different prebuild coverage; the first that loads wins, and a machine where none
// loads still runs a daemon whose `capabilities.absent` says `terminals` and why.

import { createRequire } from "node:module";
import { ptyBackend } from "../os/spawn.ts";

export interface PtyProcess {
  readonly pid: number;
  readonly cols: number;
  readonly rows: number;
  readonly process: string;
  onData(listener: (data: string) => void): { dispose(): void };
  onExit(listener: (event: { exitCode: number; signal?: number | undefined }) => void): { dispose(): void };
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}

export interface PtySpawnOptions {
  name: string;
  cols: number;
  rows: number;
  cwd: string;
  env: Record<string, string>;
  useConpty?: boolean;
}

export interface PtyModule {
  spawn(file: string, args: string[], options: PtySpawnOptions): PtyProcess;
}

export type PtyBackend = "conpty" | "winpty" | "forkpty";

export interface PtyStatus {
  available: boolean;
  /** Which package loaded, or null. */
  package: string | null;
  backend: PtyBackend | null;
  /** Why nothing loaded: the last candidate's error, naming the addon. */
  error: string | null;
}

/** In order of preference: prebuilds for every platform first, upstream last. */
export const PTY_CANDIDATES = [
  "@lydell/node-pty",
  "@homebridge/node-pty-prebuilt-multiarch",
  "node-pty",
] as const;

export type PtyLoader = () => { module: PtyModule; package: string };

const require = createRequire(import.meta.url);

/** Try each candidate; throw the last error when none loads. */
export function defaultPtyLoader(candidates: readonly string[] = PTY_CANDIDATES): {
  module: PtyModule;
  package: string;
} {
  let lastError: unknown = new Error("no PTY package candidates");
  for (const name of candidates) {
    try {
      const mod = require(name) as PtyModule;
      if (typeof mod.spawn !== "function") throw new Error(`${name} has no spawn()`);
      return { module: mod, package: name };
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

let cache: { status: PtyStatus; module: PtyModule | null } | undefined;

/** Load once, remember the outcome; a failed load is a fact about the machine, not a retry. */
export function loadPty(loader: PtyLoader = defaultPtyLoader): {
  status: PtyStatus;
  module: PtyModule | null;
} {
  if (cache && loader === defaultPtyLoader) return cache;
  let result: { status: PtyStatus; module: PtyModule | null };
  try {
    const { module, package: pkg } = loader();
    result = { status: { available: true, package: pkg, backend: ptyBackend(), error: null }, module };
  } catch (err) {
    const message = err instanceof Error ? (err.message.split("\n")[0] ?? err.message) : String(err);
    result = {
      status: {
        available: false,
        package: null,
        backend: null,
        error: `PTY addon did not load (${PTY_CANDIDATES.join(", ")}): ${message}`,
      },
      module: null,
    };
  }
  if (loader === defaultPtyLoader) cache = result;
  return result;
}

/** Tests only. */
export function resetPtyCache(): void {
  cache = undefined;
}
