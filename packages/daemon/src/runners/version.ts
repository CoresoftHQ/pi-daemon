// Which pi is installed. Detected, not pinned (spec §10).

import type { Launcher } from "../os/spawn.ts";
import { resolvePiLauncher, spawnArgv } from "../os/spawn.ts";

export interface PiInstall {
  version: string | null;
  path: string | null;
  source: Launcher["source"] | null;
}

export async function probePiVersion(
  options: {
    launcher?: Launcher | undefined;
    env?: NodeJS.ProcessEnv | undefined;
    timeoutMs?: number | undefined;
  } = {},
): Promise<PiInstall> {
  const launcher = options.launcher ?? resolvePiLauncher(options.env ?? process.env);
  if (!launcher) return { version: null, path: null, source: null };
  const path = launcher.entry ?? launcher.command;
  return new Promise((resolve) => {
    const child = spawnArgv(launcher.command, [...launcher.prefix, "--version"], {
      env: options.env ?? process.env,
    });
    let out = "";
    const timer = setTimeout(() => {
      child.kill();
      resolve({ version: null, path, source: launcher.source });
    }, options.timeoutMs ?? 15_000);
    child.stdout?.on("data", (d: Buffer) => {
      out += d.toString();
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ version: null, path, source: launcher.source });
    });
    child.on("close", () => {
      clearTimeout(timer);
      const m = /(\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.]+)?)/.exec(out);
      resolve({ version: m?.[1] ?? null, path, source: launcher.source });
    });
  });
}

/** A tiny semver range check for ">=a.b.c <x.y.z" — enough for a supported window. */
export function inSupportedRange(version: string, range: string): boolean {
  const parse = (v: string) => v.split(/[-+]/)[0]?.split(".").map(Number) ?? [];
  const cmp = (a: number[], b: number[]) => {
    for (let i = 0; i < 3; i++) {
      const d = (a[i] ?? 0) - (b[i] ?? 0);
      if (d !== 0) return d;
    }
    return 0;
  };
  const v = parse(version);
  for (const clause of range.split(/\s+/).filter(Boolean)) {
    const m = /^(>=|<=|>|<|=)?(.+)$/.exec(clause);
    if (!m?.[2]) continue;
    const c = cmp(v, parse(m[2]));
    const op = m[1] ?? "=";
    if (
      (op === ">=" && c < 0) ||
      (op === ">" && c <= 0) ||
      (op === "<=" && c > 0) ||
      (op === "<" && c >= 0) ||
      (op === "=" && c !== 0)
    )
      return false;
  }
  return true;
}
