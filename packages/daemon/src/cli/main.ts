#!/usr/bin/env node
// `pi-daemon`: serve, install, uninstall, start, stop, status, logs, pair, doctor, config,
// devices (plan M8). Every command that needs the running daemon goes through the control
// endpoint, so nothing here reaches into the daemon's files while it is running.

import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  unwatchFile,
  watchFile,
} from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { readJsonSync } from "../os/fsx.ts";
import type { LockInfo } from "../os/lock.ts";
import { LockHeldError } from "../os/lock.ts";
import type { AppDirs } from "../os/paths.ts";
import { appDirs } from "../os/paths.ts";
import { serviceManager } from "../os/service/index.ts";
import type { ServiceDefinition } from "../os/service/types.ts";
import type { DaemonConfig } from "./config.ts";
import {
  ConfigError,
  configFile,
  getPath,
  loadConfig,
  mergeConfig,
  parseConfigValue,
  readConfigDocument,
  setPath,
  validateConfig,
  writeConfigDocument,
} from "./config.ts";
import { ControlUnreachableError, controlRequest } from "./control.ts";
import { BindError, SERVICE_NAME, startDaemon } from "./daemon.ts";
import { defaultProbes, formatFindings, runDoctor } from "./doctor.ts";
import { renderQr } from "./qr.ts";

export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  env: NodeJS.ProcessEnv;
  /** Ask the operator a question; absent means non-interactive (answers default to no). */
  prompt?: ((question: string) => Promise<string>) | undefined;
  /** The entry the service should run. Defaults to this file. */
  entry?: string | undefined;
  /** Resolves when the operator interrupts a long-running command (`logs -f`). */
  interrupted?: Promise<void> | undefined;
}

const require = createRequire(import.meta.url);
export const VERSION: string = (require("../../package.json") as { version: string }).version;

const USAGE = `pi-daemon ${VERSION}

Usage: pi-daemon <command> [options]

  serve        Run the daemon in this process (--foreground logs to stderr too;
               --bind, --port, --tls override the config for this run)
  install      Register the daemon with the OS so it starts at logon (--dry-run,
               --boot-time on Windows, --linger on Linux) and start it
  uninstall    Stop and unregister it
  start        Start the installed service
  stop         Stop the running daemon (drains, then exits)
  status       What is running, where, and with what
  logs         Print the log (-n <lines>, -f to follow)
  pair         Print a pairing QR and code (--confirm asks y/N here at redemption;
               --list, --revoke <deviceId>)
  devices      create --name <name> [--role owner|member]: a token for a service, printed once
  doctor       Diagnose the install
  config       get [key] | set <key> <value> | unset <key> | path

Options: --json for machine-readable output where it applies; --help; --version
Files:   PI_DAEMON_HOME=<dir> keeps everything under one directory.
`;

export async function runCli(argv: string[], io: CliIo): Promise<number> {
  let parsed: Parsed;
  try {
    parsed = parse(argv);
  } catch (err) {
    io.stderr(`${err instanceof Error ? err.message : String(err)}\n\n${USAGE}`);
    return 2;
  }
  const { values, positionals } = parsed;
  if (values.version) {
    io.stdout(`${VERSION}\n`);
    return 0;
  }
  const command = positionals[0];
  if (values.help || !command) {
    io.stdout(USAGE);
    return command ? 0 : 2;
  }
  const dirs = appDirs("pi-daemon", io.env);
  try {
    switch (command) {
      case "serve":
        return await serve(dirs, io, values);
      case "install":
        return await install(dirs, io, values);
      case "uninstall":
        return await uninstall(dirs, io);
      case "start":
        return await start(io);
      case "stop":
        return await stop(dirs, io);
      case "status":
        return await status(dirs, io, values.json ?? false);
      case "logs":
        return await logs(dirs, io, values);
      case "pair":
        return await pair(dirs, io, values);
      case "devices":
        return await devices(dirs, io, positionals.slice(1), values);
      case "doctor":
        return await doctor(dirs, io, values.json ?? false);
      case "config":
        return config(dirs, io, positionals.slice(1));
      default:
        io.stderr(`unknown command: ${command}\n\n${USAGE}`);
        return 2;
    }
  } catch (err) {
    if (err instanceof ConfigError) {
      io.stderr(`${err.message}\n  (${configFile(dirs)})\n`);
      return 2;
    }
    if (err instanceof ControlUnreachableError) {
      io.stderr(
        "the daemon is not running (nothing answers on its control endpoint); `pi-daemon status` has details\n",
      );
      return 3;
    }
    io.stderr(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

const OPTIONS = {
  options: {
    help: { type: "boolean", short: "h" },
    version: { type: "boolean", short: "v" },
    json: { type: "boolean" },
    foreground: { type: "boolean" },
    bind: { type: "string" },
    port: { type: "string" },
    tls: { type: "string" },
    "dry-run": { type: "boolean" },
    "boot-time": { type: "boolean" },
    linger: { type: "boolean" },
    confirm: { type: "boolean" },
    list: { type: "boolean" },
    revoke: { type: "string" },
    follow: { type: "boolean", short: "f" },
    lines: { type: "string", short: "n" },
    name: { type: "string" },
    role: { type: "string" },
    platform: { type: "string" },
  },
} as const;

function parse(args: string[]) {
  return parseArgs({ args, options: OPTIONS.options, allowPositionals: true, strict: true });
}
type Parsed = ReturnType<typeof parse>;
type Values = Parsed["values"];

function loadWithOverrides(dirs: AppDirs, values: Values): DaemonConfig {
  const base = loadConfig(dirs);
  const overrides: Record<string, unknown> = {};
  if (values.bind) overrides.bind = values.bind;
  if (values.port) overrides.port = Number(values.port);
  if (values.tls) overrides.tls = values.tls;
  if (Object.keys(overrides).length === 0) return base;
  const problems: string[] = [];
  const merged = mergeConfig({ ...structuredClone(base), ...overrides }, problems);
  problems.push(...validateConfig(merged));
  if (problems.length) throw new ConfigError(problems);
  return merged;
}

async function serve(dirs: AppDirs, io: CliIo, values: Values): Promise<number> {
  const config = loadWithOverrides(dirs, values);
  try {
    const daemon = await startDaemon({
      dirs,
      config,
      version: VERSION,
      env: io.env,
      foreground: values.foreground ?? false,
    });
    io.stderr(
      `pi-daemon ${VERSION} listening on ${daemon.address}:${daemon.port} (${daemon.tls?.mode ?? "no tls"}); daemon ${daemon.identity.id}\n`,
    );
    const reason = await daemon.stopped;
    io.stderr(`stopped (${reason})\n`);
    return 0;
  } catch (err) {
    if (err instanceof LockHeldError) {
      io.stderr(`another pi-daemon is already running: pid ${err.holder.pid}, port ${err.holder.port}\n`);
      return 3;
    }
    if (err instanceof BindError) {
      io.stderr(`${err.message}\n`);
      return 2;
    }
    throw err;
  }
}

function serviceDefinition(dirs: AppDirs, io: CliIo, values: Values): ServiceDefinition {
  const entry = io.entry ?? fileURLToPath(import.meta.url);
  const argv = [
    process.execPath,
    ...(entry.endsWith(".ts") ? ["--conditions=development"] : []),
    entry,
    "serve",
  ];
  const env: Record<string, string> = {};
  if (io.env.PI_DAEMON_HOME) env.PI_DAEMON_HOME = io.env.PI_DAEMON_HOME;
  if (io.env.PATH) env.PATH = io.env.PATH;
  return {
    name: SERVICE_NAME,
    description: "pi-daemon: Pi Coding Agent sessions, workspaces, and terminals for remote clients",
    argv,
    env,
    logFile: path.join(dirs.logs, "service.log"),
    bootTime: values["boot-time"] ?? false,
    linger: values.linger ?? true,
  };
}

async function install(dirs: AppDirs, io: CliIo, values: Values): Promise<number> {
  loadConfig(dirs); // refuse to install a daemon that cannot start
  const manager = serviceManager();
  const def = serviceDefinition(dirs, io, values);
  if (values["dry-run"]) {
    io.stdout(`${manager.render(def)}\n`);
    return 0;
  }
  await manager.install(def);
  await manager
    .start(SERVICE_NAME)
    .catch((err) =>
      io.stderr(`installed, but start failed: ${err instanceof Error ? err.message : String(err)}\n`),
    );
  const s = await manager.status(SERVICE_NAME);
  io.stdout(
    `installed as a ${manager.kind} service: ${s.state}${s.detail ? ` (${s.detail})` : ""}\nlogs: ${path.join(dirs.logs, "pi-daemon.log")}\n`,
  );
  return 0;
}

async function uninstall(dirs: AppDirs, io: CliIo): Promise<number> {
  await controlRequest(dirs.state, "stop", {}, { timeoutMs: 3000 }).catch(() => undefined);
  const manager = serviceManager();
  await manager.stop(SERVICE_NAME).catch(() => undefined);
  await manager.uninstall(SERVICE_NAME);
  io.stdout("uninstalled\n");
  return 0;
}

async function start(io: CliIo): Promise<number> {
  const manager = serviceManager();
  const before = await manager.status(SERVICE_NAME);
  if (!before.installed) {
    io.stderr("the service is not installed; run `pi-daemon install`, or `pi-daemon serve` to run it here\n");
    return 3;
  }
  await manager.start(SERVICE_NAME);
  const after = await manager.status(SERVICE_NAME);
  io.stdout(`${after.state}\n`);
  return after.state === "running" ? 0 : 1;
}

async function stop(dirs: AppDirs, io: CliIo): Promise<number> {
  const ping = () =>
    controlRequest(dirs.state, "ping", {}, { timeoutMs: 1000 }).then(
      () => true,
      () => false,
    );
  if (await ping()) {
    await controlRequest(dirs.state, "stop", {}, { timeoutMs: 3000 });
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
      if (!(await ping())) {
        io.stdout("stopped\n");
        return 0;
      }
    }
    io.stderr("asked the daemon to stop, but it is still answering after 30 s\n");
    return 1;
  }
  const manager = serviceManager();
  const s = await manager.status(SERVICE_NAME).catch(() => null);
  if (s?.installed && s.state === "running") {
    await manager.stop(SERVICE_NAME);
    io.stdout("stopped (service)\n");
    return 0;
  }
  io.stdout("not running\n");
  return 0;
}

async function status(dirs: AppDirs, io: CliIo, json: boolean): Promise<number> {
  const live = await controlRequest(dirs.state, "status", {}, { timeoutMs: 3000 }).catch(() => null);
  const service = await serviceManager()
    .status(SERVICE_NAME)
    .catch(() => null);
  const lock = readJsonSync<LockInfo>(path.join(dirs.state, "pi-daemon.lock"));
  if (json) {
    io.stdout(`${JSON.stringify({ running: live !== null, daemon: live, service, lock, dirs }, null, 2)}\n`);
    return live ? 0 : 3;
  }
  if (live) {
    const s = live as Record<string, unknown>;
    const pi = s.pi as { version: string | null; path: string | null };
    io.stdout(
      [
        `running     pid ${s.pid}, version ${s.version}, since ${new Date(Number(s.startedAt)).toISOString()}`,
        `daemon      ${s.name} (${s.daemonId})`,
        `listening   ${s.address}:${s.port} (${s.tls})${s.fingerprint ? `, fingerprint ${String(s.fingerprint).slice(0, 16)}…` : ""}`,
        `advertised  ${s.advertisedHost}`,
        `pi          ${pi.version ?? "not found"}${pi.path ? ` (${pi.path})` : ""}`,
        `live        ${s.sessions} sessions, ${s.terminals} terminals; ${s.workspaces} workspaces, ${s.devices} devices`,
        `service     ${service ? (service.installed ? `${service.state}` : "not installed") : "n/a"}`,
        `files       ${dirs.data}`,
      ].join("\n"),
    );
    io.stdout("\n");
    return 0;
  }
  io.stdout(
    `not running${lock ? ` (stale lock: pid ${lock.pid}, port ${lock.port})` : ""}\nservice     ${service ? (service.installed ? service.state : "not installed") : "n/a"}\nfiles       ${dirs.data}\n`,
  );
  return 3;
}

async function logs(dirs: AppDirs, io: CliIo, values: Values): Promise<number> {
  const file = path.join(dirs.logs, "pi-daemon.log");
  if (!existsSync(file)) {
    io.stderr(`no log yet at ${file}\n`);
    return 3;
  }
  const n = Math.max(1, Number(values.lines ?? 50) || 50);
  const text = readFileSync(file, "utf8");
  const lines = text.split("\n").filter((l) => l.length > 0);
  io.stdout(`${lines.slice(-n).join("\n")}\n`);
  if (!values.follow) return 0;
  let offset = statSync(file).size;
  const read = () => {
    let size: number;
    try {
      size = statSync(file).size;
    } catch {
      return;
    }
    if (size < offset) offset = 0; // rotated
    if (size === offset) return;
    const fd = openSync(file, "r");
    try {
      const buf = Buffer.alloc(size - offset);
      readSync(fd, buf, 0, buf.length, offset);
      io.stdout(buf.toString("utf8"));
    } finally {
      closeSync(fd);
    }
    offset = size;
  };
  watchFile(file, { interval: 500 }, read);
  await (io.interrupted ?? new Promise<void>(() => undefined));
  unwatchFile(file, read);
  return 0;
}

async function pair(dirs: AppDirs, io: CliIo, values: Values): Promise<number> {
  if (values.list) {
    const list = (await controlRequest(dirs.state, "devices.list")) as Array<Record<string, unknown>>;
    if (values.json) io.stdout(`${JSON.stringify(list, null, 2)}\n`);
    else if (list.length === 0) io.stdout("no devices paired\n");
    else
      for (const d of list)
        io.stdout(
          `${String(d.id).padEnd(18)} ${String(d.role).padEnd(7)} ${String(d.platform).padEnd(8)} ${d.name}  (last seen ${d.lastSeenAt ? new Date(Number(d.lastSeenAt)).toISOString() : "never"})\n`,
        );
    return 0;
  }
  if (values.revoke) {
    const r = (await controlRequest(dirs.state, "devices.revoke", { id: values.revoke })) as {
      revoked: boolean;
    };
    io.stdout(r.revoked ? `revoked ${values.revoke}\n` : `no device ${values.revoke}\n`);
    return r.revoked ? 0 : 3;
  }
  const confirm = values.confirm ?? false;
  const result = (await controlRequest(
    dirs.state,
    "pair.issue",
    { confirm },
    {
      timeoutMs: confirm ? 200_000 : 5000,
      onEvent: async (event, data) => {
        if (event !== "confirm") return undefined;
        const d = data as { deviceName: string; platform: string };
        if (!io.prompt) {
          io.stderr(`redemption by "${d.deviceName}" (${d.platform}) refused: no terminal to confirm on\n`);
          return false;
        }
        const answer = await io.prompt(`allow "${d.deviceName}" (${d.platform}) to pair? [y/N] `);
        return /^y(es)?$/i.test(answer.trim());
      },
    },
  )) as { code: string; expiresAt: number; payload: Record<string, unknown> | null; redeemed?: unknown };
  if (!result.payload) {
    io.stderr("could not build a pairing payload\n");
    return 1;
  }
  const text = JSON.stringify(result.payload);
  if (values.json) {
    io.stdout(`${JSON.stringify({ ...result.payload, expiresAt: result.expiresAt }, null, 2)}\n`);
  } else if (!confirm) {
    io.stdout(
      `${renderQr(text)}\n${text}\n\ncode ${result.code}  (valid until ${new Date(result.expiresAt).toLocaleTimeString()}, single use)\n`,
    );
  }
  if (confirm) {
    if (result.redeemed) io.stdout(`paired: ${JSON.stringify(result.redeemed)}\n`);
    else io.stdout("nobody redeemed the code before it expired\n");
    return result.redeemed ? 0 : 3;
  }
  return 0;
}

async function devices(dirs: AppDirs, io: CliIo, args: string[], values: Values): Promise<number> {
  const sub = args[0];
  if (sub === "create") {
    if (!values.name) {
      io.stderr("devices create needs --name\n");
      return 2;
    }
    const r = (await controlRequest(dirs.state, "devices.create", {
      name: values.name,
      platform: values.platform ?? "service",
      role: values.role ?? "member",
    })) as { device: Record<string, unknown>; token: string };
    if (values.json) io.stdout(`${JSON.stringify(r, null, 2)}\n`);
    else
      io.stdout(
        `device ${r.device.id} (${r.device.role})\ntoken  ${r.token}\n\nThis token is shown once. It is equivalent to shell access as this user (spec §7.1).\n`,
      );
    return 0;
  }
  if (sub === "list") return pair(dirs, io, { ...values, list: true });
  if (sub === "revoke" && args[1]) return pair(dirs, io, { ...values, revoke: args[1] });
  io.stderr("usage: pi-daemon devices create --name <name> [--role owner|member] | list | revoke <id>\n");
  return 2;
}

async function doctor(dirs: AppDirs, io: CliIo, json: boolean): Promise<number> {
  let config: DaemonConfig;
  try {
    config = loadConfig(dirs);
  } catch (err) {
    if (err instanceof ConfigError) {
      io.stderr(`FAIL  config  ${err.problems.join("; ")}\n`);
      return 1;
    }
    throw err;
  }
  const findings = await runDoctor(dirs, config, defaultProbes(dirs, config, io.env));
  io.stdout(json ? `${JSON.stringify(findings, null, 2)}\n` : `${formatFindings(findings)}\n`);
  return findings.some((f) => f.verdict === "fail") ? 1 : 0;
}

function config(dirs: AppDirs, io: CliIo, args: string[]): number {
  const [sub, key, value] = args;
  switch (sub) {
    case undefined:
    case "get": {
      const effective = loadConfig(dirs);
      const v = key ? getPath(effective, key) : effective;
      if (v === undefined) {
        io.stderr(`no such key: ${key}\n`);
        return 3;
      }
      io.stdout(`${JSON.stringify(v, null, 2)}\n`);
      return 0;
    }
    case "set": {
      if (!key || value === undefined) {
        io.stderr("usage: pi-daemon config set <key> <value>\n");
        return 2;
      }
      const doc = setPath(readConfigDocument(dirs), key, parseConfigValue(value));
      const problems: string[] = [];
      const merged = mergeConfig(doc, problems);
      problems.push(...validateConfig(merged));
      if (problems.length) {
        io.stderr(`refused:\n  ${problems.join("\n  ")}\n`);
        return 2;
      }
      writeConfigDocument(dirs, doc);
      io.stdout(
        `${key} = ${JSON.stringify(getPath(merged, key))}\n(restart the daemon for it to take effect)\n`,
      );
      return 0;
    }
    case "unset": {
      if (!key) {
        io.stderr("usage: pi-daemon config unset <key>\n");
        return 2;
      }
      writeConfigDocument(dirs, setPath(readConfigDocument(dirs), key, undefined));
      io.stdout(`${key} unset\n`);
      return 0;
    }
    case "path":
      io.stdout(`${configFile(dirs)}\n`);
      return 0;
    default:
      io.stderr("usage: pi-daemon config get [key] | set <key> <value> | unset <key> | path\n");
      return 2;
  }
}

// ---- entry

function isMain(): boolean {
  const arg = process.argv[1];
  if (!arg) return false;
  try {
    return import.meta.url === pathToFileURL(arg).href;
  } catch {
    return false;
  }
}

if (isMain()) {
  const rl = process.stdin.isTTY ? createInterface({ input: process.stdin, output: process.stderr }) : null;
  const interrupted = new Promise<void>((resolve) => {
    process.once("SIGINT", () => resolve());
  });
  const io: CliIo = {
    stdout: (t) => process.stdout.write(t),
    stderr: (t) => process.stderr.write(t),
    env: process.env,
    prompt: rl ? (q) => new Promise((resolve) => rl.question(q, resolve)) : undefined,
    interrupted,
  };
  runCli(process.argv.slice(2), io).then(
    (code) => {
      rl?.close();
      process.exitCode = code;
      // `serve` has already torn everything down; nothing else keeps the loop alive on purpose.
      if (process.argv[2] !== "serve") setTimeout(() => process.exit(code), 50).unref();
    },
    (err) => {
      process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
      process.exit(1);
    },
  );
}
