import assert from "node:assert/strict";
import { test } from "node:test";
import { appDirs } from "../os/paths.ts";
import { DEFAULT_CONFIG } from "./config.ts";
import type { DoctorProbes, Finding } from "./doctor.ts";
import { formatFindings, runDoctor } from "./doctor.ts";

const dirs = appDirs("pi-daemon", { PI_DAEMON_HOME: "/tmp/pid-doctor" });
const launcher = { command: "/usr/bin/pi", prefix: [], source: "path" as const };

function healthy(): DoctorProbes {
  return {
    nodeVersion: () => "24.16.0",
    piLauncher: () => launcher,
    piVersion: async () => ({ version: "0.84.4", path: "/usr/bin/pi", source: "path" }),
    piModels: async () => 3,
    daemonRunning: async () => null,
    portFree: async () => true,
    writable: () => true,
    tailnet: async () => ({
      running: true,
      ips: ["100.64.0.1"],
      dnsName: "box.tail.ts.net",
      selfUserId: 1,
      users: new Map(),
      peersByIp: new Map(),
    }),
    certificate: () => ({ notAfter: Date.now() + 200 * 86_400_000, subject: "CN=box" }),
    service: async () => ({ state: "running", installed: true }),
    clockSkewSeconds: async () => 2,
    ptyAvailable: () => ({ available: true, error: null }),
  };
}

const verdict = (f: Finding[], check: string) => f.find((x) => x.check === check)?.verdict;

test("a healthy machine is all ok", async () => {
  const f = await runDoctor(dirs, DEFAULT_CONFIG, healthy());
  assert.ok(
    f.every((x) => x.verdict === "ok" || x.verdict === "skip"),
    formatFindings(f),
  );
  assert.equal(verdict(f, "daemon"), "skip");
  assert.equal(verdict(f, "port"), "ok");
});

test("every diagnosis the plan lists has a verdict and a fix", async () => {
  const p = healthy();
  p.nodeVersion = () => "20.11.0";
  p.piLauncher = () => null;
  p.portFree = async () => false;
  p.writable = (dir) => !dir.endsWith("logs");
  p.tailnet = async () => null;
  p.certificate = () => ({ notAfter: Date.now() + 5 * 86_400_000, subject: "CN=box" });
  p.service = async () => ({ state: "not-installed", installed: false });
  p.clockSkewSeconds = async () => -400;
  p.ptyAvailable = () => ({
    available: false,
    error: "PTY addon did not load (@lydell/node-pty): Cannot find module",
  });
  const f = await runDoctor(dirs, { ...DEFAULT_CONFIG, bind: "tailscale", tls: "auto" }, p);
  assert.equal(verdict(f, "node"), "fail");
  assert.equal(verdict(f, "pi"), "fail");
  assert.match(f.find((x) => x.check === "pi")?.fix ?? "", /npm i -g/);
  assert.equal(verdict(f, "port"), "fail");
  assert.equal(verdict(f, "logs dir"), "fail");
  assert.equal(verdict(f, "data dir"), "ok");
  assert.equal(verdict(f, "tailscale"), "fail", "bind needs it");
  assert.equal(verdict(f, "certificate"), "warn");
  assert.equal(verdict(f, "service"), "warn");
  assert.equal(verdict(f, "clock"), "warn");
  assert.match(f.find((x) => x.check === "clock")?.detail ?? "", /400 s behind/);
  assert.equal(verdict(f, "terminals"), "warn");
  const text = formatFindings(f);
  assert.match(text, /FAIL {2}node/);
  assert.match(text, /-> install Node/);
});

test("pi outside the range warns, no provider fails, a running daemon replaces the port check", async () => {
  const p = healthy();
  p.piVersion = async () => ({ version: "0.90.0", path: "/usr/bin/pi", source: "path" });
  p.piModels = async () => 0;
  p.daemonRunning = async () => ({ pid: 4242, port: 8790 });
  p.portFree = async () => {
    throw new Error("must not be probed while the daemon runs");
  };
  const f = await runDoctor(dirs, DEFAULT_CONFIG, p);
  assert.equal(verdict(f, "pi"), "warn");
  assert.equal(verdict(f, "pi providers"), "fail");
  assert.equal(verdict(f, "daemon"), "ok");
  assert.match(f.find((x) => x.check === "daemon")?.detail ?? "", /pid 4242/);
  assert.equal(verdict(f, "port"), undefined);
  assert.equal(verdict(f, "tailscale"), "ok");
});
