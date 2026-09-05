// Process execution (spec §9): argv arrays only, never a shell string; resolve the pi binary
// once; kill whole trees, because a runner spawns tool children and a shell spawns everything.

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, statSync } from "node:fs";
import path from "node:path";
import { platform } from "./paths.ts";

export interface SpawnArgvOptions {
  cwd?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  stdio?: "pipe" | "ignore" | ["pipe" | "ignore", "pipe" | "ignore", "pipe" | "ignore"] | undefined;
  /** POSIX: put the child in its own process group so the whole tree can be signalled. */
  ownGroup?: boolean | undefined;
}

/** Spawn with an argv array. There is deliberately no way to pass a shell string. */
export function spawnArgv(
  command: string,
  args: readonly string[],
  options: SpawnArgvOptions = {},
): ChildProcess {
  return spawn(command, [...args], {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: options.stdio ?? "pipe",
    windowsHide: true,
    detached: platform !== "win32" && (options.ownGroup ?? false),
  });
}

function isExecutable(p: string): boolean {
  try {
    if (!statSync(p).isFile()) return false;
    if (platform === "win32") return true;
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Find an executable on PATH, honouring PATHEXT on Windows. */
export function findOnPath(name: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const dirs = (env.PATH ?? env.Path ?? "").split(path.delimiter).filter(Boolean);
  const exts = platform === "win32" ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";") : [""];
  for (const dir of dirs) {
    for (const ext of ["", ...exts]) {
      const candidate = path.join(dir, name + ext);
      if (isExecutable(candidate)) return candidate;
    }
  }
  return null;
}

export interface Launcher {
  command: string;
  prefix: string[];
  /** How it was found, for `doctor`. */
  source: "env" | "path" | "npm-shim";
  /** The pi entry that will actually run, when known. */
  entry?: string | undefined;
}

/**
 * Resolve how to start pi. The global `pi` on Windows is an npm `.cmd` shim, which Node refuses
 * to spawn without a shell (a deliberate security default), so the daemon locates the CLI entry
 * the shim points at and runs it under its own `node`. PI_DAEMON_PI=<path> overrides: a JS entry
 * runs under node, anything else runs directly.
 */
export function resolvePiLauncher(env: NodeJS.ProcessEnv = process.env): Launcher | null {
  const override = env.PI_DAEMON_PI;
  if (override) {
    return /\.(?:m?js|cjs)$/i.test(override)
      ? { command: process.execPath, prefix: [override], source: "env", entry: override }
      : { command: override, prefix: [], source: "env" };
  }
  const found = findOnPath("pi", env);
  if (!found) return null;
  // npm global layout: <prefix>/pi(.cmd) next to <prefix>/node_modules/@earendil-works/pi-coding-agent
  const entry = path.join(
    path.dirname(found),
    "node_modules",
    "@earendil-works",
    "pi-coding-agent",
    "dist",
    "bundle",
    "cli.js",
  );
  if (existsSync(entry)) return { command: process.execPath, prefix: [entry], source: "npm-shim", entry };
  if (platform === "win32" && /\.(?:cmd|bat|ps1)$/i.test(found)) return null; // a shim we cannot follow
  return { command: found, prefix: [], source: "path" };
}

export interface ShellChoice {
  command: string;
  /** Build argv for one literal user command. */
  argsFor: (userCommand: string) => string[];
  /** For interactive use: argv for a login shell with no command. */
  interactiveArgs: string[];
}

/**
 * Only for a command a *user* typed. The daemon's own invocations never go through a shell.
 * POSIX: $SHELL -lc. Windows: pwsh, then powershell.exe, then cmd (spec §9).
 */
export function userShell(env: NodeJS.ProcessEnv = process.env): ShellChoice {
  if (platform === "win32") {
    const pwsh = findOnPath("pwsh", env);
    if (pwsh)
      return { command: pwsh, argsFor: (c) => ["-NoProfile", "-Command", c], interactiveArgs: ["-NoLogo"] };
    const ps = findOnPath("powershell", env) ?? "powershell.exe";
    if (ps !== "powershell.exe" || existsSync(ps))
      return { command: ps, argsFor: (c) => ["-NoProfile", "-Command", c], interactiveArgs: ["-NoLogo"] };
    return { command: env.ComSpec ?? "cmd.exe", argsFor: (c) => ["/d", "/s", "/c", c], interactiveArgs: [] };
  }
  const sh = env.SHELL && isExecutable(env.SHELL) ? env.SHELL : "/bin/sh";
  return { command: sh, argsFor: (c) => ["-lc", c], interactiveArgs: ["-l"] };
}

/**
 * Kill a process and everything under it. Genuinely different per platform: Windows has no
 * process groups, so `taskkill /T` walks the tree; POSIX signals the group the child was
 * spawned into (`ownGroup: true`), falling back to the pid alone.
 */
export function killTree(pid: number, signal: NodeJS.Signals = "SIGKILL"): void {
  if (!Number.isInteger(pid) || pid <= 0) return;
  if (platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      /* already gone */
    }
  }
}

/** True when a pid currently exists. Pid reuse means this is a hint, never proof (spec §9). */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (platform === "win32") {
    const out =
      spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], {
        encoding: "utf8",
        windowsHide: true,
      }).stdout ?? "";
    return out.includes(`"${pid}"`);
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}
