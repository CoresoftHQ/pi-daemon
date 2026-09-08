// `pi-daemon doctor` (plan M8): the diagnoses an operator actually hits, each a small probe
// with an injectable implementation so the verdicts are testable without the conditions.

import { X509Certificate } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import type { TailnetStatus } from "../access/tailscale.ts";
import { tailnetStatus } from "../access/tailscale.ts";
import type { AppDirs } from "../os/paths.ts";
import type { ServiceStatus } from "../os/service/types.ts";
import type { Launcher } from "../os/spawn.ts";
import { resolvePiLauncher } from "../os/spawn.ts";
import type { PiInstall } from "../runners/version.ts";
import { inSupportedRange, probePiVersion } from "../runners/version.ts";
import { SUPPORTED_PI_RANGE } from "../serve/v1/capabilities.ts";
import { probeAvailableModels } from "../sessions/models.ts";
import { loadPty } from "../terminals/pty.ts";
import type { DaemonConfig } from "./config.ts";
import { controlRequest } from "./control.ts";

export type Verdict = "ok" | "warn" | "fail" | "skip";

export interface Finding {
  check: string;
  verdict: Verdict;
  detail: string;
  /** What to do about it, when there is something. */
  fix?: string;
}

export interface DoctorProbes {
  nodeVersion: () => string;
  piLauncher: () => Launcher | null;
  piVersion: (launcher: Launcher) => Promise<PiInstall>;
  /** Models pi can use: empty means no authenticated provider. */
  piModels: (launcher: Launcher) => Promise<number>;
  /** Is the daemon itself answering on its control endpoint? */
  daemonRunning: () => Promise<{ pid: number; port: number } | null>;
  portFree: (port: number, address: string) => Promise<boolean>;
  writable: (dir: string) => boolean;
  tailnet: () => Promise<TailnetStatus | null>;
  certificate: () => { notAfter: number; subject: string } | null;
  service: () => Promise<ServiceStatus | null>;
  /** Seconds this clock is ahead of a trusted source; null when unknown. */
  clockSkewSeconds: () => Promise<number | null>;
  ptyAvailable: () => { available: boolean; error: string | null };
}

export const MIN_NODE = "22.19.0";

export function defaultProbes(
  dirs: AppDirs,
  config: DaemonConfig,
  env: NodeJS.ProcessEnv = process.env,
): DoctorProbes {
  const piEnv: NodeJS.ProcessEnv = config.pi.path ? { ...env, PI_DAEMON_PI: config.pi.path } : env;
  return {
    nodeVersion: () => process.versions.node,
    piLauncher: () => resolvePiLauncher(piEnv),
    piVersion: (launcher) => probePiVersion({ launcher, env: piEnv, timeoutMs: 15_000 }),
    piModels: async (launcher) => {
      // the daemon creates its directories on start; before that, probe from somewhere that exists
      mkdirSync(dirs.state, { recursive: true });
      return (await probeAvailableModels({ cwd: dirs.state, env: piEnv, launcher })).length;
    },
    daemonRunning: () =>
      controlRequest(dirs.state, "ping", {}, { timeoutMs: 1500 }).then(
        (r) => r as { pid: number; port: number },
        () => null,
      ),
    portFree: (port, address) =>
      new Promise((resolve) => {
        const s = net.createServer();
        s.once("error", () => resolve(false));
        s.listen(port, address, () => s.close(() => resolve(true)));
      }),
    writable: (dir) => {
      const probe = path.join(dir, `.doctor-${process.pid}`);
      try {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        writeFileSync(probe, "ok");
        rmSync(probe);
        return true;
      } catch {
        return false;
      }
    },
    tailnet: () => tailnetStatus().catch(() => null),
    certificate: () => {
      const file = path.join(dirs.state, "tls", "cert.pem");
      if (!existsSync(file)) return null;
      try {
        const cert = new X509Certificate(readFileSync(file));
        return { notAfter: Date.parse(cert.validTo), subject: cert.subject };
      } catch {
        return null;
      }
    },
    service: async () => {
      const { serviceManager } = await import("../os/service/index.ts");
      return serviceManager()
        .status("pi-daemon")
        .catch(() => null);
    },
    clockSkewSeconds: async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3000);
      try {
        const res = await fetch("https://www.google.com/generate_204", {
          method: "HEAD",
          signal: controller.signal,
        });
        const date = res.headers.get("date");
        if (!date) return null;
        return Math.round((Date.now() - Date.parse(date)) / 1000);
      } catch {
        return null;
      } finally {
        clearTimeout(timer);
      }
    },
    ptyAvailable: () => {
      const s = loadPty().status;
      return { available: s.available, error: s.error };
    },
  };
}

function semverGte(a: string, b: string): boolean {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}

export async function runDoctor(
  dirs: AppDirs,
  config: DaemonConfig,
  probes: DoctorProbes,
): Promise<Finding[]> {
  const out: Finding[] = [];
  const add = (check: string, verdict: Verdict, detail: string, fix?: string) =>
    out.push({ check, verdict, detail, ...(fix ? { fix } : {}) });

  const node = probes.nodeVersion();
  if (semverGte(node, MIN_NODE)) add("node", "ok", `v${node}`);
  else add("node", "fail", `v${node} is older than the required v${MIN_NODE}`, "install Node 22.19 or newer");

  const launcher = probes.piLauncher();
  if (!launcher) {
    add(
      "pi",
      "fail",
      config.pi.path ? `pi.path (${config.pi.path}) does not resolve` : "no `pi` on PATH",
      "npm i -g @earendil-works/pi-coding-agent, or set pi.path",
    );
  } else {
    const pi = await probes.piVersion(launcher);
    if (!pi.version)
      add(
        "pi",
        "fail",
        `pi at ${launcher.command} did not report a version`,
        "run `pi --version` yourself and check the install",
      );
    else if (inSupportedRange(pi.version, SUPPORTED_PI_RANGE))
      add("pi", "ok", `${pi.version} (${launcher.source}${pi.path ? `, ${pi.path}` : ""})`);
    else
      add(
        "pi",
        "warn",
        `${pi.version} is outside the tested range ${SUPPORTED_PI_RANGE}`,
        "the daemon will still try; upgrade the daemon or pin pi if things break",
      );
    try {
      const n = await probes.piModels(launcher);
      if (n > 0) add("pi providers", "ok", `${n} model${n === 1 ? "" : "s"} available`);
      else
        add(
          "pi providers",
          "fail",
          "pi lists no models: no provider is authenticated",
          "run `pi` once and sign in, or set the provider's API key in pi's settings",
        );
    } catch (err) {
      add(
        "pi providers",
        "warn",
        `could not list models: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const running = await probes.daemonRunning();
  const address =
    config.bind === "loopback" ? "127.0.0.1" : config.bind === "tailscale" ? "0.0.0.0" : config.bind;
  if (running) add("daemon", "ok", `running, pid ${running.pid}, port ${running.port}`);
  else {
    add("daemon", "skip", "not running");
    if (await probes.portFree(config.port, address))
      add("port", "ok", `${config.port} on ${address} is free`);
    else
      add(
        "port",
        "fail",
        `${config.port} on ${address} is in use by something else`,
        "set a different `port`, or stop whatever holds it",
      );
  }

  for (const [name, dir] of [
    ["data", dirs.data],
    ["state", dirs.state],
    ["logs", dirs.logs],
  ] as const) {
    if (probes.writable(dir)) add(`${name} dir`, "ok", dir);
    else add(`${name} dir`, "fail", `${dir} is not writable`, "fix its permissions or set PI_DAEMON_HOME");
  }

  const ts = await probes.tailnet();
  if (ts?.running)
    add(
      "tailscale",
      "ok",
      ts.dnsName ? `${ts.dnsName} (${ts.ips.join(", ")})` : ts.ips.join(", ") || "running",
    );
  else if (config.bind === "tailscale" || config.tls === "tailscale-cert")
    add(
      "tailscale",
      "fail",
      "not running, but `bind` or `tls` needs it",
      "start Tailscale, or set bind to loopback",
    );
  else
    add(
      "tailscale",
      ts ? "warn" : "skip",
      ts ? "installed but not running" : "not installed; tailnet identity will not be shown",
    );

  const cert = probes.certificate();
  if (cert) {
    const days = Math.floor((cert.notAfter - Date.now()) / 86_400_000);
    if (days < 0)
      add(
        "certificate",
        "fail",
        `expired ${-days} day${days === -1 ? "" : "s"} ago (${cert.subject})`,
        "delete the tls directory under state and restart; it is regenerated",
      );
    else if (days < 30)
      add(
        "certificate",
        "warn",
        `expires in ${days} day${days === 1 ? "" : "s"} (${cert.subject})`,
        "the daemon renews on start; restart it before then",
      );
    else add("certificate", "ok", `valid for ${days} more days`);
  } else
    add(
      "certificate",
      "skip",
      config.bind === "loopback" && config.tls !== "self-signed"
        ? "not needed for loopback"
        : "none yet; generated on first start",
    );

  const svc = await probes.service();
  if (!svc) add("service", "skip", "no service manager available");
  else if (!svc.installed)
    add("service", "warn", "not installed; the daemon only runs while you run it", "pi-daemon install");
  else
    add(
      "service",
      svc.state === "running" ? "ok" : "warn",
      `installed, ${svc.state}${svc.detail ? ` (${svc.detail})` : ""}`,
      svc.state === "running" ? undefined : "pi-daemon start",
    );

  const skew = await probes.clockSkewSeconds();
  if (skew === null) add("clock", "skip", "could not reach a time source");
  else if (Math.abs(skew) > 60)
    add(
      "clock",
      "warn",
      `this clock is ${Math.abs(skew)} s ${skew > 0 ? "ahead" : "behind"}`,
      "pairing codes and TLS depend on time; enable NTP",
    );
  else add("clock", "ok", `within ${Math.abs(skew)} s`);

  const pty = probes.ptyAvailable();
  if (!config.terminals.enabled) add("terminals", "skip", "switched off (terminals.enabled)");
  else if (pty.available) add("terminals", "ok", "PTY addon loaded");
  else
    add(
      "terminals",
      "warn",
      pty.error ?? "PTY addon did not load",
      "npm i @lydell/node-pty in the daemon's install, or use a platform with a prebuild",
    );

  return out;
}

export function formatFindings(findings: Finding[]): string {
  const mark: Record<Verdict, string> = { ok: "ok  ", warn: "warn", fail: "FAIL", skip: "--  " };
  const width = Math.max(...findings.map((f) => f.check.length));
  return findings
    .map(
      (f) => `${mark[f.verdict]}  ${f.check.padEnd(width)}  ${f.detail}${f.fix ? `\n      -> ${f.fix}` : ""}`,
    )
    .join("\n");
}
