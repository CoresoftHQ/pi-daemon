// The composition root: everything M1–M7 built, wired into one process (spec §2, §6.5, §8).
// This file owns startup order, the capability document computed from real state, the control
// endpoint, and shutdown. It is the only place that knows about all the modules at once.

import http from "node:http";
import https from "node:https";
import net from "node:net";
import path from "node:path";
import type { Capabilities } from "@coresoft-hq/pi-daemon-contract";
import type { WebSocketServer } from "ws";
import type { AccessControl } from "../access/authenticate.ts";
import { createUpgradeAuthenticator } from "../access/authenticate.ts";
import type { DaemonIdentity } from "../access/daemon-identity.ts";
import { loadOrCreateIdentity } from "../access/daemon-identity.ts";
import { DeviceStore } from "../access/devices.ts";
import { createAccessRoutes } from "../access/http.ts";
import type { RedeemRequest } from "../access/pairing.ts";
import { PairingService } from "../access/pairing.ts";
import { RateLimiter } from "../access/ratelimit.ts";
import type { TailscaleExec } from "../access/tailscale.ts";
import { runTailscale, TailnetStatusCache } from "../access/tailscale.ts";
import { ConnectTickets } from "../access/tickets.ts";
import type { TlsMaterial } from "../access/tls.ts";
import { selfSignedMaterial, tailscaleCertMaterial } from "../access/tls.ts";
import { ensureDir } from "../os/fsx.ts";
import { localEndpointPath } from "../os/ipc.ts";
import type { Lock } from "../os/lock.ts";
import { acquireLock } from "../os/lock.ts";
import type { Logger } from "../os/log.ts";
import { createLogger } from "../os/log.ts";
import type { AppDirs } from "../os/paths.ts";
import { hostName, piAgentDir, piSessionsDir, platform } from "../os/paths.ts";
import type { Launcher } from "../os/spawn.ts";
import { resolvePiLauncher } from "../os/spawn.ts";
import type { PiInstall } from "../runners/version.ts";
import { inSupportedRange, probePiVersion } from "../runners/version.ts";
import { PiProtocolServer } from "../serve/pi-protocol/server.ts";
import { attachWebSocketListener, listenLocalEndpoint, PI_PROTOCOL_PATH } from "../serve/pi-protocol/ws.ts";
import { buildCapabilities, SUPPORTED_PI_RANGE } from "../serve/v1/capabilities.ts";
import { attachEventWebSocket } from "../serve/v1/events.ts";
import { createV1Router } from "../serve/v1/routes.ts";
import { attachTerminalStream, TERMINAL_STREAM_PATTERN } from "../serve/v1/terminal-stream.ts";
import { registryResolver } from "../serve/workspace-resolver.ts";
import { EventLog } from "../sessions/events.ts";
import { SessionHost } from "../sessions/host.ts";
import type { AvailableModel } from "../sessions/models.ts";
import { probeAvailableModels } from "../sessions/models.ts";
import { TerminalManager } from "../terminals/manager.ts";
import { gitAvailable } from "../workspaces/git.ts";
import { WorkspaceRegistry } from "../workspaces/registry.ts";
import { WorkspaceService } from "../workspaces/service.ts";
import type { DaemonConfig } from "./config.ts";
import type { ControlServer } from "./control.ts";
import { controlRequest, startControlServer } from "./control.ts";

export interface StartOptions {
  dirs: AppDirs;
  config: DaemonConfig;
  version: string;
  /** Test injection: how to start pi. Defaults to PATH / config.pi.path resolution. */
  launcher?: Launcher | null | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  /** Log to stderr as well as the file (a foreground `serve`). */
  foreground?: boolean | undefined;
  tailscale?: TailscaleExec | undefined;
  logger?: Logger | undefined;
  now?: (() => number) | undefined;
}

export type StopReason = "signal" | "control" | "service" | "error" | "test";

export interface RunningDaemon {
  identity: DaemonIdentity;
  /** Where clients connect: the bind address and port, and the name pairing advertises. */
  address: string;
  port: number;
  advertisedHost: string;
  tls: TlsMaterial | null;
  pi: PiInstall;
  lock: Lock;
  control: ControlServer;
  log: Logger;
  host: SessionHost;
  workspaces: WorkspaceService;
  terminals: TerminalManager;
  devices: DeviceStore;
  pairing: PairingService;
  capabilities(): Capabilities;
  /** Idempotent. Resolves when everything is down and the lock is released. */
  stop(reason: StopReason): Promise<void>;
  /** Resolves with the reason once stop() has finished. */
  stopped: Promise<StopReason>;
}

export class BindError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BindError";
  }
}

const SERVICE_NAME = "pi-daemon";

export async function startDaemon(options: StartOptions): Promise<RunningDaemon> {
  const { dirs, config } = options;
  const now = options.now ?? Date.now;
  const env = options.env ?? process.env;
  for (const d of [dirs.data, dirs.config, dirs.state, dirs.logs]) await ensureDir(d, 0o700);
  const log =
    options.logger ??
    createLogger({
      file: path.join(dirs.logs, "pi-daemon.log"),
      maxBytes: config.log.maxBytes,
      maxFiles: config.log.maxFiles,
      stderr: options.foreground ?? false,
      level: config.log.level,
    });

  // ---- where to listen, and how (spec §6.5)
  const tailscale = options.tailscale ?? runTailscale;
  const tailnetCache = new TailnetStatusCache({ run: tailscale, now });
  const tailnetNow = () => tailnetCache.refresh().catch(() => null);
  let address: string;
  let advertisedHost: string;
  if (config.bind === "loopback") {
    address = "127.0.0.1";
    advertisedHost = "127.0.0.1";
  } else if (config.bind === "tailscale") {
    const ts = await tailnetNow();
    if (!ts?.running || ts.ips.length === 0)
      throw new BindError("bind is tailscale but Tailscale is not running; `pi-daemon doctor` has details");
    address = ts.ips[0] ?? "";
    advertisedHost = ts.dnsName ?? address;
  } else {
    address = config.bind;
    advertisedHost = config.bind === "0.0.0.0" || config.bind === "::" ? hostName() : config.bind;
    if (platform === "win32")
      log.warn("first non-loopback bind on Windows raises a firewall prompt", { address });
  }
  const tlsMode =
    config.tls === "auto"
      ? config.bind === "loopback"
        ? "off"
        : config.bind === "tailscale"
          ? "tailscale-cert"
          : "self-signed"
      : config.tls;
  let tls: TlsMaterial | null = null;
  if (tlsMode === "self-signed") {
    tls = await selfSignedMaterial({
      dir: path.join(dirs.state, "tls"),
      hosts: unique([hostName(), advertisedHost, address, "localhost", "127.0.0.1"]),
    });
  } else if (tlsMode === "tailscale-cert") {
    const ts = await tailnetNow();
    if (!ts?.dnsName)
      throw new BindError(
        "tls is tailscale-cert but this machine has no MagicDNS name; is Tailscale running with MagicDNS on?",
      );
    tls = await tailscaleCertMaterial({
      dir: path.join(dirs.state, "tls"),
      dnsName: ts.dnsName,
      run: (args) => tailscale(args),
    });
    advertisedHost = ts.dnsName;
  }

  // ---- one instance (spec §9)
  const lock = await acquireLock(
    path.join(dirs.state, "pi-daemon.lock"),
    { pid: process.pid, port: config.port, startedAt: now() },
    {
      probe: () =>
        controlRequest(dirs.state, "ping", {}, { timeoutMs: 1500 }).then(
          () => true,
          () => false,
        ),
    },
  );

  const events = new EventLog({
    maxEvents: config.limits.replayRingEvents,
    maxBytes: config.limits.replayRingBytes,
  });
  const identity = loadOrCreateIdentity(path.join(dirs.data, "daemon.json"), {
    name: config.name ?? hostName(),
    now,
  });
  const devices = new DeviceStore(path.join(dirs.data, "devices.json"));
  const tickets = new ConnectTickets();
  const access: AccessControl = {
    devices,
    tickets,
    failures: new RateLimiter({ windowMs: 15 * 60_000, max: 10, now }),
    tailnet: { status: () => tailnetCache.current(), allowedUsers: config.tailnet.allowedUsers },
  };
  let confirmHook: ((request: RedeemRequest) => Promise<boolean>) | null = null;
  const pairing = new PairingService({
    devices,
    daemonId: identity.id,
    now,
    confirm: (request) => (confirmHook ? confirmHook(request) : Promise.resolve(true)),
    onRedeemed: (device, request) => {
      log.info("device paired", {
        deviceId: device.id,
        name: request.deviceName,
        platform: request.platform,
      });
      events.append("daemon", "device.paired", { deviceId: device.id, name: device.name, role: device.role });
    },
  });

  // ---- pi
  const piEnv: NodeJS.ProcessEnv = config.pi.path ? { ...env, PI_DAEMON_PI: config.pi.path } : env;
  const launcher = options.launcher === undefined ? resolvePiLauncher(piEnv) : options.launcher;
  const pi = launcher
    ? await probePiVersion({ launcher, env: piEnv, timeoutMs: 15_000 }).catch(
        () => ({ version: null, path: null, source: null }) as PiInstall,
      )
    : { version: null, path: null, source: null };
  if (!launcher) log.warn("pi not found; sessions cannot start until it is installed or pi.path is set");
  else if (pi.version && !inSupportedRange(pi.version, SUPPORTED_PI_RANGE))
    log.warn("pi version outside the supported range", {
      version: pi.version,
      supported: SUPPORTED_PI_RANGE,
    });

  // ---- workspaces, sessions, terminals
  const registry = new WorkspaceRegistry({
    file: path.join(dirs.data, "workspaces.json"),
    worktreesRoot: path.join(dirs.data, "worktrees"),
    now,
    isBusy: (id) =>
      host
        .list()
        .some((s) => s.live && (s.workspaceId === id || resolver.workspaceFor(s.cwd)?.workspaceId === id)) ||
      terminals.busy(id),
  });
  const resolver = registryResolver(registry);
  const workspaces = new WorkspaceService({
    registry,
    publish: (scope, type, payload) => events.append(scope, type, payload),
    filesWrite: config.files.write,
    now,
    log,
  });
  const host = new SessionHost({
    log: events,
    ...(launcher ? { launcher } : {}),
    env: piEnv,
    runner: {
      extensions: config.pi.extensions,
      isolate: config.pi.isolate,
      ...(config.pi.tools ? { tools: config.pi.tools } : {}),
      excludeTools: config.pi.excludeTools,
      noTools: config.pi.noTools,
      ...(config.pi.trust ? { trust: config.pi.trust } : {}),
    },
    sessionsDir: piSessionsDir(piAgentDir()),
    idleTimeoutMs: config.limits.idleTimeoutMs,
    maxRunners: config.limits.maxRunners,
    now,
  });
  const terminals = new TerminalManager({
    publish: (scope, type, payload) => events.append(scope, type, payload),
    enabled: config.terminals.enabled,
    maxTerminals: config.limits.maxTerminals,
    scrollbackLines: config.limits.scrollbackLines,
    env: piEnv,
    now,
    log,
  });
  let models: AvailableModel[] = [];
  if (launcher) {
    models = await probeAvailableModels({ cwd: dirs.state, env: piEnv, launcher }).catch((err) => {
      log.warn("could not list pi's models", { error: err instanceof Error ? err.message : String(err) });
      return [];
    });
  }

  const startedAt = now();
  const capabilities = (): Capabilities => {
    const term = terminals.capability();
    const features = ["dialogs", "fork", "sse", "groups", "files", "diff"];
    const absent = ["commandRuns", "push", "containers", "turnResume", "terminalPersistence"];
    (config.files.write ? features : absent).push("files.write");
    (gitAvailable() ? features : absent).push("worktrees");
    (term.feature ? features : absent).push("terminals");
    return buildCapabilities({
      identity,
      version: options.version,
      platform,
      startedAt,
      pi: { version: pi.version, supported: SUPPORTED_PI_RANGE, path: pi.path },
      maxFrameLength: config.limits.maxFrameLength,
      features,
      absent,
      limits: {
        maxRunners: config.limits.maxRunners,
        maxTerminals: config.limits.maxTerminals,
        scrollbackLines: config.limits.scrollbackLines,
        maxFileBytes: config.limits.maxFileBytes,
        idleTimeoutMs: config.limits.idleTimeoutMs,
        replayRing: config.limits.replayRingEvents,
      },
    });
  };
  if (!terminals.capability().feature)
    log.warn("terminals absent", { reason: terminals.capability().reason });

  // ---- the servers
  const protocol = new PiProtocolServer({
    host,
    workspaces: resolver,
    models: () => models,
    serverId: identity.id,
    maxFrameLength: config.limits.maxFrameLength,
    maxBufferedBytes: config.limits.maxBufferedBytes,
    log,
  });
  const accessRoutes = createAccessRoutes({
    access,
    pairing,
    daemon: identity,
    capabilities,
    onRevoked: (id) => {
      protocol.closeForDevice(id);
      events.append("daemon", "device.revoked", { deviceId: id });
    },
    log,
    now,
  });
  const v1 = createV1Router({
    host,
    workspaces: resolver,
    workspaceService: workspaces,
    terminals,
    maxFileBytes: config.limits.maxFileBytes,
    access,
    capabilities,
    version: options.version,
    events: { log: events, access, logger: log, maxBufferedBytes: config.limits.maxBufferedBytes },
    log,
    now,
  });
  const handler = (req: http.IncomingMessage, res: http.ServerResponse) => {
    void (async () => {
      try {
        if (await accessRoutes(req, res)) return;
        if (await v1.handle(req, res)) return;
        res
          .writeHead(404, { "content-type": "application/json" })
          .end(JSON.stringify({ error: { code: "not_found", message: "no such route" } }));
      } catch (err) {
        log.error("request failed", {
          url: req.url,
          error: err instanceof Error ? err.message : String(err),
        });
        if (!res.headersSent)
          res
            .writeHead(500, { "content-type": "application/json" })
            .end(JSON.stringify({ error: { code: "internal_error", message: "request failed" } }));
        else res.destroy();
      }
    })();
  };
  const server = tls
    ? https.createServer({ cert: tls.cert, key: tls.key }, handler)
    : http.createServer(handler);
  const upgradeAuth = createUpgradeAuthenticator(access);
  const eventWss = attachEventWebSocket(server, {
    log: events,
    access,
    logger: log,
    maxBufferedBytes: config.limits.maxBufferedBytes,
  });
  const protoWss = attachWebSocketListener(server, { server: protocol, authenticate: upgradeAuth, log });
  const termWss = attachTerminalStream(server, {
    manager: terminals,
    authenticate: upgradeAuth,
    maxBufferedBytes: config.limits.maxBufferedBytes,
    log,
  });
  server.on("upgrade", (req, socket) => {
    const p = new URL(req.url ?? "/", "http://localhost").pathname;
    if (p !== "/v1/events" && p !== PI_PROTOCOL_PATH && !TERMINAL_STREAM_PATTERN.test(p)) socket.destroy();
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(config.port, address, () => {
        server.off("error", reject);
        resolve();
      });
    });
  } catch (err) {
    lock.release();
    const code = (err as NodeJS.ErrnoException).code;
    throw new BindError(
      code === "EADDRINUSE"
        ? `port ${config.port} on ${address} is already in use`
        : `cannot listen on ${address}:${config.port}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const localServer = net.createServer();
  await listenLocalEndpoint(protocol, localEndpointPath(dirs.state), localServer).catch((err) => {
    log.warn("local endpoint unavailable", { error: err instanceof Error ? err.message : String(err) });
  });

  // ---- shutdown (spec §8)
  let stopping: Promise<void> | null = null;
  let resolveStopped!: (reason: StopReason) => void;
  const stopped = new Promise<StopReason>((r) => {
    resolveStopped = r;
  });
  const stop = (reason: StopReason): Promise<void> => {
    if (stopping) return stopping;
    stopping = (async () => {
      log.info("stopping", { reason });
      events.append("daemon", "daemon.shutdown", { reason, drainMs: config.drainMs });
      removeSignalHandlers();
      server.close();
      localServer.close();
      protocol.closeAll();
      for (const wss of [eventWss, protoWss, termWss] as WebSocketServer[])
        for (const c of wss.clients) c.terminate();
      server.closeAllConnections();
      await Promise.all([terminals.closeAll("shutdown", Math.min(config.drainMs, 3000)), host.close()]);
      workspaces.close();
      await control.close();
      lock.release();
      log.info("stopped", { reason });
      resolveStopped(reason);
    })();
    return stopping;
  };
  const onSignal = () => void stop("signal");
  const signals: NodeJS.Signals[] =
    platform === "win32" ? ["SIGINT", "SIGBREAK"] : ["SIGINT", "SIGTERM", "SIGHUP"];
  for (const s of signals) process.on(s, onSignal);
  const removeSignalHandlers = () => {
    for (const s of signals) process.off(s, onSignal);
  };

  // ---- the control endpoint (spec §8): signal-less stop, status, pairing, devices
  const control = await startControlServer(dirs.state, {
    ping: async () => ({ pid: process.pid, port: config.port }),
    status: async () => ({
      pid: process.pid,
      version: options.version,
      daemonId: identity.id,
      name: identity.name,
      address,
      port: config.port,
      advertisedHost,
      tls: tls?.mode ?? "off",
      fingerprint: tls?.fingerprint ?? null,
      startedAt,
      pi,
      sessions: host.list().filter((s) => s.live).length,
      terminals: terminals.list().filter((t) => t.status === "running").length,
      workspaces: registry.workspaces().length,
      devices: devices.list().length,
      capabilities: capabilities(),
    }),
    stop: async (_p, ctx) => {
      ctx.emit("stopping");
      setTimeout(() => void stop("control"), 10);
      return { stopping: true };
    },
    capabilities: async () => capabilities(),
    "pair.issue": async (params, ctx) => {
      const confirm = params.confirm === true;
      const code = pairing.issue();
      const payload = pairing.payload({
        host: advertisedHost,
        port: config.port,
        fingerprint: tls?.fingerprint,
      });
      if (!confirm) return { code: code.code, expiresAt: code.expiresAt, payload };
      // Stay on the line: the daemon asks this CLI y/N at redemption and reports the outcome.
      confirmHook = async (request) => {
        const answer = await ctx.ask("confirm", {
          deviceName: request.deviceName,
          platform: request.platform,
        });
        return answer === true;
      };
      const previousHook = confirmHook;
      const outcome = await new Promise<unknown>((resolve) => {
        const off = events.subscribe((e) => {
          if (e.type === "device.paired") {
            off();
            resolve(e.payload);
          }
        });
        setTimeout(
          () => {
            off();
            resolve(null);
          },
          Math.max(1000, code.expiresAt - now() + 500),
        );
      });
      if (confirmHook === previousHook) confirmHook = null;
      return { code: code.code, expiresAt: code.expiresAt, payload, redeemed: outcome };
    },
    "pair.active": async () => pairing.active(),
    "devices.list": async () => devices.list(),
    "devices.revoke": async (params) => {
      const id = String(params.id ?? "");
      const ok = devices.revoke(id);
      if (ok) {
        protocol.closeForDevice(id);
        events.append("daemon", "device.revoked", { deviceId: id });
      }
      return { revoked: ok };
    },
    "devices.create": async (params) => {
      const role = params.role === "owner" ? "owner" : "member";
      const created = devices.create({
        name: String(params.name ?? "service"),
        platform: String(params.platform ?? "service"),
        role,
      });
      return { device: created.device, token: created.token };
    },
  });

  workspaces.start();
  log.info("listening", {
    address,
    port: config.port,
    tls: tls?.mode ?? "off",
    advertisedHost,
    pi: pi.version,
    piPath: pi.path,
    local: localEndpointPath(dirs.state),
    control: control.endpoint,
    daemonId: identity.id,
  });

  return {
    identity,
    address,
    port: config.port,
    advertisedHost,
    tls,
    pi,
    lock,
    control,
    log,
    host,
    workspaces,
    terminals,
    devices,
    pairing,
    capabilities,
    stop,
    stopped,
  };
}

function unique(items: string[]): string[] {
  return [...new Set(items.filter((s) => s.length > 0))];
}

export { SERVICE_NAME };
