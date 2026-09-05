// Directory resolution. Resolved here, never inlined at a call site (spec §9).

import os from "node:os";
import path from "node:path";

export type Platform = "win32" | "darwin" | "linux";

/** The one place the daemon reads process.platform. Everything else asks `os/` for behaviour. */
export const platform: Platform =
  process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux";

export interface AppDirs {
  /** Durable data: registries, device records. */
  data: string;
  /** Operator-edited configuration. */
  config: string;
  /** Machine state: the lock file, the local socket, caches. */
  state: string;
  /** Rotated JSON-line logs. */
  logs: string;
}

export interface PathsEnv {
  LOCALAPPDATA?: string | undefined;
  XDG_DATA_HOME?: string | undefined;
  XDG_CONFIG_HOME?: string | undefined;
  XDG_STATE_HOME?: string | undefined;
  PI_DAEMON_HOME?: string | undefined;
}

/**
 * Where the daemon keeps its own files on each platform:
 *   Windows  %LOCALAPPDATA%\pi-daemon
 *   macOS    ~/Library/Application Support/pi-daemon  (logs under ~/Library/Logs)
 *   Linux    $XDG_{DATA,CONFIG,STATE}_HOME/pi-daemon
 * PI_DAEMON_HOME overrides all four with one directory, for tests and for operators who want it.
 */
export function appDirs(
  name = "pi-daemon",
  env: PathsEnv = process.env,
  home: string = os.homedir(),
  plat: Platform = platform,
): AppDirs {
  if (env.PI_DAEMON_HOME) {
    const base = path.resolve(env.PI_DAEMON_HOME);
    return { data: base, config: base, state: base, logs: path.join(base, "logs") };
  }
  switch (plat) {
    case "win32": {
      const base = path.join(env.LOCALAPPDATA ?? path.join(home, "AppData", "Local"), name);
      return { data: base, config: base, state: base, logs: path.join(base, "logs") };
    }
    case "darwin": {
      const base = path.join(home, "Library", "Application Support", name);
      return { data: base, config: base, state: base, logs: path.join(home, "Library", "Logs", name) };
    }
    default: {
      const data = path.join(env.XDG_DATA_HOME ?? path.join(home, ".local", "share"), name);
      const config = path.join(env.XDG_CONFIG_HOME ?? path.join(home, ".config"), name);
      const state = path.join(env.XDG_STATE_HOME ?? path.join(home, ".local", "state"), name);
      return { data, config, state, logs: path.join(state, "logs") };
    }
  }
}

/** pi's own agent directory. The daemon reads session metadata from under it (spec §2.2). */
export function piAgentDir(home: string = os.homedir(), override?: string | undefined): string {
  return override ? path.resolve(override) : path.join(home, ".pi", "agent");
}

export function piSessionsDir(agentDir: string): string {
  return path.join(agentDir, "sessions");
}

export function homeDir(): string {
  return os.homedir();
}

export function tmpDir(): string {
  return os.tmpdir();
}

export function userName(): string {
  try {
    return os.userInfo().username;
  } catch {
    return "user";
  }
}
