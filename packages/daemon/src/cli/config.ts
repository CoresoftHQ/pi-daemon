// The operator's configuration (spec §6.5, §7.3, §10): one JSON file, every key with a default,
// validated on load with the offending key named. `pi-daemon config get|set` edits it; the
// daemon reads it once at start.

import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { readJsonSync, writeJsonAtomicSync } from "../os/fsx.ts";
import type { LogLevel } from "../os/log.ts";
import type { AppDirs } from "../os/paths.ts";

export type BindMode = "loopback" | "tailscale" | (string & {});
export type TlsSetting = "auto" | "off" | "self-signed" | "tailscale-cert";

export interface DaemonConfig {
  /** Display name in capabilities and pairing; null means the hostname. */
  name: string | null;
  /** "loopback", "tailscale", or an explicit address to bind. */
  bind: BindMode;
  port: number;
  /** "auto" is off for loopback, tailscale-cert for tailscale, self-signed for an explicit address. */
  tls: TlsSetting;
  pi: {
    /** The pi entry to run; null means PATH. */
    path: string | null;
    extensions: string[];
    /** Runner tool set pinned at spawn (spec §7.3); null means pi's default. */
    tools: string[] | null;
    excludeTools: string[];
    noTools: boolean;
    isolate: boolean;
    /** pi's own trust flag for every runner (-a / -na); null leaves pi's default (spec §7). */
    trust: "approve" | "no-approve" | null;
  };
  limits: {
    maxRunners: number;
    idleTimeoutMs: number;
    maxTerminals: number;
    scrollbackLines: number;
    maxFileBytes: number;
    replayRingEvents: number;
    replayRingBytes: number;
    maxFrameLength: number;
    maxBufferedBytes: number;
  };
  files: { write: boolean };
  terminals: { enabled: boolean };
  /** Browser clients from other origins; empty means none. "*" allows any. Tokens are still required. */
  cors: { origins: string[] };
  tailnet: {
    /** Login names allowed from the tailnet; empty means no restriction. Tokens are still required. */
    allowedUsers: string[];
  };
  log: { level: LogLevel; maxBytes: number; maxFiles: number };
  /** Shutdown: how long runners get to reach a persisted boundary before the tree-kill. */
  drainMs: number;
}

export const DEFAULT_CONFIG: DaemonConfig = {
  name: null,
  bind: "loopback",
  port: 8790,
  tls: "auto",
  pi: {
    path: null,
    extensions: [],
    tools: null,
    excludeTools: [],
    noTools: false,
    isolate: false,
    trust: null,
  },
  limits: {
    maxRunners: 8,
    idleTimeoutMs: 30 * 60_000,
    maxTerminals: 16,
    scrollbackLines: 10_000,
    maxFileBytes: 4 * 1024 * 1024,
    replayRingEvents: 2000,
    replayRingBytes: 16 * 1024 * 1024,
    maxFrameLength: 8 * 1024 * 1024,
    maxBufferedBytes: 8 * 1024 * 1024,
  },
  files: { write: true },
  terminals: { enabled: true },
  cors: { origins: [] },
  tailnet: { allowedUsers: [] },
  log: { level: "info", maxBytes: 10 * 1024 * 1024, maxFiles: 5 },
  drainMs: 10_000,
};

export class ConfigError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`configuration is invalid:\n  ${problems.join("\n  ")}`);
    this.name = "ConfigError";
    this.problems = problems;
  }
}

export function configFile(dirs: AppDirs): string {
  return path.join(dirs.config, "config.json");
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Deep-merge a partial document over the defaults; unknown keys are problems, not silence. */
export function mergeConfig(partial: unknown, problems: string[] = [], prefix = ""): DaemonConfig {
  const out = structuredClone(DEFAULT_CONFIG) as unknown as Record<string, unknown>;
  if (partial === undefined || partial === null) return out as unknown as DaemonConfig;
  if (!isObj(partial)) {
    problems.push(`${prefix || "config"}: expected an object`);
    return out as unknown as DaemonConfig;
  }
  const walk = (target: Record<string, unknown>, source: Record<string, unknown>, at: string) => {
    for (const [key, value] of Object.entries(source)) {
      const where = at ? `${at}.${key}` : key;
      if (!(key in target)) {
        problems.push(`${where}: unknown key`);
        continue;
      }
      const current = target[key];
      if (isObj(current) && !Array.isArray(current)) {
        if (!isObj(value)) problems.push(`${where}: expected an object`);
        else walk(current, value, where);
      } else {
        target[key] = value;
      }
    }
  };
  walk(out, partial, prefix);
  return out as unknown as DaemonConfig;
}

/** Type and range checks, every failure named. */
export function validateConfig(c: DaemonConfig): string[] {
  const p: string[] = [];
  const int = (v: unknown, name: string, min: number, max: number) => {
    if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max)
      p.push(`${name}: expected an integer between ${min} and ${max}`);
  };
  const bool = (v: unknown, name: string) => {
    if (typeof v !== "boolean") p.push(`${name}: expected true or false`);
  };
  const strings = (v: unknown, name: string) => {
    if (!Array.isArray(v) || v.some((s) => typeof s !== "string"))
      p.push(`${name}: expected an array of strings`);
  };
  if (c.name !== null && typeof c.name !== "string") p.push("name: expected a string or null");
  if (typeof c.bind !== "string" || c.bind.length === 0)
    p.push('bind: expected "loopback", "tailscale", or an address');
  int(c.port, "port", 1, 65535);
  if (!["auto", "off", "self-signed", "tailscale-cert"].includes(c.tls))
    p.push('tls: expected "auto", "off", "self-signed", or "tailscale-cert"');
  if (c.tls === "off" && c.bind !== "loopback")
    p.push("tls: off is only allowed with bind: loopback (spec §6.5)");
  if (c.pi.path !== null && typeof c.pi.path !== "string") p.push("pi.path: expected a string or null");
  strings(c.pi.extensions, "pi.extensions");
  if (c.pi.tools !== null) strings(c.pi.tools, "pi.tools");
  strings(c.pi.excludeTools, "pi.excludeTools");
  bool(c.pi.noTools, "pi.noTools");
  bool(c.pi.isolate, "pi.isolate");
  if (c.pi.trust !== null && c.pi.trust !== "approve" && c.pi.trust !== "no-approve")
    p.push('pi.trust: expected "approve", "no-approve", or null');
  int(c.limits.maxRunners, "limits.maxRunners", 1, 256);
  int(c.limits.idleTimeoutMs, "limits.idleTimeoutMs", 10_000, 7 * 86_400_000);
  int(c.limits.maxTerminals, "limits.maxTerminals", 0, 256);
  int(c.limits.scrollbackLines, "limits.scrollbackLines", 0, 100_000);
  int(c.limits.maxFileBytes, "limits.maxFileBytes", 1024, 1024 * 1024 * 1024);
  int(c.limits.replayRingEvents, "limits.replayRingEvents", 100, 1_000_000);
  int(c.limits.replayRingBytes, "limits.replayRingBytes", 1024 * 1024, 1024 * 1024 * 1024);
  int(c.limits.maxFrameLength, "limits.maxFrameLength", 64 * 1024, 256 * 1024 * 1024);
  int(c.limits.maxBufferedBytes, "limits.maxBufferedBytes", 64 * 1024, 256 * 1024 * 1024);
  bool(c.files.write, "files.write");
  bool(c.terminals.enabled, "terminals.enabled");
  strings(c.cors.origins, "cors.origins");
  if (Array.isArray(c.cors.origins) && c.cors.origins.some((o) => o !== "*" && !/^https?:\/\/[^/]+$/.test(o)))
    p.push('cors.origins: each entry is "*" or an origin like https://app.example.com (no path)');
  strings(c.tailnet.allowedUsers, "tailnet.allowedUsers");
  if (!["debug", "info", "warn", "error"].includes(c.log.level))
    p.push('log.level: expected "debug", "info", "warn", or "error"');
  int(c.log.maxBytes, "log.maxBytes", 64 * 1024, 1024 * 1024 * 1024);
  int(c.log.maxFiles, "log.maxFiles", 1, 100);
  int(c.drainMs, "drainMs", 0, 600_000);
  return p;
}

/** Read, merge, validate. A missing file is the defaults. Throws ConfigError. */
export function loadConfig(dirs: AppDirs): DaemonConfig {
  const file = configFile(dirs);
  const problems: string[] = [];
  let raw: unknown;
  if (existsSync(file)) {
    try {
      raw = readJsonSync<unknown>(file);
    } catch (err) {
      throw new ConfigError([`${file}: ${err instanceof Error ? err.message : String(err)}`]);
    }
  }
  const merged = mergeConfig(raw, problems);
  problems.push(...validateConfig(merged));
  if (problems.length) throw new ConfigError(problems);
  return merged;
}

/** The document on disk (partial), for editing. */
export function readConfigDocument(dirs: AppDirs): Record<string, unknown> {
  const file = configFile(dirs);
  if (!existsSync(file)) return {};
  const raw = readJsonSync<unknown>(file);
  return isObj(raw) ? raw : {};
}

export function writeConfigDocument(dirs: AppDirs, doc: Record<string, unknown>): void {
  mkdirSync(dirs.config, { recursive: true, mode: 0o700 });
  writeJsonAtomicSync(configFile(dirs), doc, { mode: 0o600 });
}

/** `a.b.c` lookup. */
export function getPath(doc: unknown, dotted: string): unknown {
  let cur: unknown = doc;
  for (const key of dotted.split(".")) {
    if (!isObj(cur)) return undefined;
    cur = cur[key];
  }
  return cur;
}

/** `a.b.c` assignment, creating objects on the way; returns the new document. */
export function setPath(
  doc: Record<string, unknown>,
  dotted: string,
  value: unknown,
): Record<string, unknown> {
  const out = structuredClone(doc);
  const keys = dotted.split(".");
  let cur = out;
  for (const key of keys.slice(0, -1)) {
    if (!isObj(cur[key])) cur[key] = {};
    cur = cur[key] as Record<string, unknown>;
  }
  const last = keys[keys.length - 1] ?? "";
  if (value === undefined) delete cur[last];
  else cur[last] = value;
  return out;
}

/** Parse a `config set` value: JSON if it parses, otherwise the literal string. */
export function parseConfigValue(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
