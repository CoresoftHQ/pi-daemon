#!/usr/bin/env node
// The M9 soak and load run against the real composition root with the fake pi:
//   node --conditions=development scripts/soak.mjs --minutes 3 [--sessions 8] [--terminals 16] [--clients 5]
// Phases run concurrently for the whole duration: runners at the cap with LRU eviction,
// terminals at the cap with one streaming to nobody, N clients fanned out on one session and
// one terminal with a flapping reconnect, deliberate runner crashes and rehydrations. Every
// 10 s it prints memory, handles, and child-process counts; at the end it stops the daemon
// and reports orphans and growth. Exit code 1 on orphans or unbounded growth.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import WebSocket from "ws";
import { DEFAULT_CONFIG } from "../packages/daemon/src/cli/config.ts";
import { startDaemon } from "../packages/daemon/src/cli/daemon.ts";
import { createLogger } from "../packages/daemon/src/os/log.ts";
import { appDirs } from "../packages/daemon/src/os/paths.ts";

const { values: opts } = parseArgs({
  options: {
    minutes: { type: "string", default: "3" },
    sessions: { type: "string", default: "8" },
    terminals: { type: "string", default: "16" },
    clients: { type: "string", default: "5" },
  },
});
const MINUTES = Number(opts.minutes);
const SESSIONS = Number(opts.sessions);
const TERMINALS = Number(opts.terminals);
const CLIENTS = Number(opts.clients);
const FAKE = path.resolve(import.meta.dirname, "..", "packages", "daemon", "test", "fake-pi.mjs");
const launcher = { command: process.execPath, prefix: [FAKE], source: "env" };
const win = process.platform === "win32";

const root = mkdtempSync(path.join(os.tmpdir(), "pi-daemon-soak-"));
const dirs = appDirs("pi-daemon", { PI_DAEMON_HOME: root });
const ws = path.join(root, "workspace");
mkdirSync(ws);
writeFileSync(path.join(ws, "README.md"), "# soak\n");
const port = await new Promise((resolve) => {
  const s = net.createServer();
  s.listen(0, "127.0.0.1", () => {
    const p = s.address().port;
    s.close(() => resolve(p));
  });
});
const config = {
  ...DEFAULT_CONFIG,
  port,
  limits: { ...DEFAULT_CONFIG.limits, maxRunners: SESSIONS, maxTerminals: TERMINALS, idleTimeoutMs: 20_000 },
};
const daemon = await startDaemon({
  dirs,
  config,
  version: "soak",
  launcher,
  env: process.env,
  logger: createLogger({ file: path.join(dirs.logs, "pi-daemon.log"), level: "info", stderr: false }),
});
const { workspaces } = await daemon.workspaces.register(ws);
const wsId = workspaces[0].id;
const token = daemon.devices.create({ name: "soak", platform: "script" }).token;
const base = `http://127.0.0.1:${port}`;
const wsBase = `ws://127.0.0.1:${port}`;
const headers = { authorization: `Bearer ${token}` };

const api = async (method, url, body) => {
  const res = await fetch(base + url, {
    method,
    headers: { ...headers, ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : {} };
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const counters = {
  prompts: 0,
  crashes: 0,
  evictions: 0,
  rehydrations: 0,
  reconnects: 0,
  terminalBytes: 0,
  eventFrames: 0,
  errors: 0,
};
const errors = [];
const fail = (what, err) => {
  // our own flapper tearing down a socket that had not finished connecting is not the daemon's fault
  if (String(err instanceof Error ? err.message : err).includes("before the connection was established")) return;
  counters.errors += 1;
  if (errors.length < 20) errors.push(`${what}: ${err instanceof Error ? err.message : String(err)}`);
};
daemon.host.log.subscribe((e) => {
  if (e.type === "session.evicted") counters.evictions += 1;
});

// ---- phase A: runners at the cap, LRU eviction, crashes and rehydration
const sessionIds = [];
for (let i = 0; i < SESSIONS; i++) {
  const r = await api("POST", "/v1/sessions", { workspaceId: wsId, name: `soak-${i}` });
  if (r.status !== 201) throw new Error(`create session: ${r.status} ${JSON.stringify(r.body)}`);
  sessionIds.push(r.body.session.id);
}
async function runnersPhase(deadline) {
  let i = 0;
  while (Date.now() < deadline) {
    const id = sessionIds[i++ % sessionIds.length];
    try {
      const kind = i % 17 === 0 ? "CRASH" : i % 5 === 0 ? "SLOW" : "hello";
      const r = await api("POST", `/v1/sessions/${id}/prompt`, { text: `${kind} soak ${i}` });
      if (r.status === 202) counters.prompts += 1;
      else if (r.status !== 409) fail("prompt", `${r.status} ${JSON.stringify(r.body)}`);
      if (kind === "CRASH") {
        counters.crashes += 1;
        await sleep(300);
        const s = await api("GET", `/v1/sessions/${id}`);
        if (s.status === 200) counters.rehydrations += 1;
        else fail("rehydrate after crash", s.status);
      }
      if (i % 11 === 0) {
        // one over the cap: the LRU runner is evicted, the session stays listable
        const extra = await api("POST", "/v1/sessions", { workspaceId: wsId, name: `soak-extra-${i}` });
        if (extra.status === 201) sessionIds.push(extra.body.session.id);
        else if (extra.status !== 503) fail("extra session", extra.status);
      }
    } catch (err) {
      fail("runners phase", err);
    }
    await sleep(250);
  }
}

// ---- phase B: terminals at the cap, one streaming to nobody, and one over
const terminalIds = [];
async function terminalsPhase(deadline) {
  const spew = [
    process.execPath,
    "-e",
    "setInterval(() => process.stdout.write('tick ' + Date.now() + '\\n'), 100)",
  ];
  for (let i = 0; i < TERMINALS; i++) {
    const r = await api("POST", `/v1/workspaces/${wsId}/terminals`, {
      cols: 100,
      rows: 30,
      argv: i === 0 ? spew : undefined,
    });
    if (r.status === 201) terminalIds.push(r.body.terminal.id);
    else fail("open terminal", `${r.status} ${JSON.stringify(r.body)}`);
  }
  const over = await api("POST", `/v1/workspaces/${wsId}/terminals`, { cols: 80, rows: 24 });
  if (over.status !== 503) fail("terminal cap", `expected 503, got ${over.status}`);
  while (Date.now() < deadline) {
    // churn: close one, open another, type into a few
    const victim = terminalIds.splice(1 + Math.floor(Math.random() * (terminalIds.length - 1)), 1)[0];
    if (victim) await api("DELETE", `/v1/terminals/${victim}?grace=300`);
    const r = await api("POST", `/v1/workspaces/${wsId}/terminals`, { cols: 80, rows: 24 });
    if (r.status === 201) terminalIds.push(r.body.terminal.id);
    await sleep(3000);
  }
}

// ---- phase C: fan-out on one session and one terminal, with a flapping client
function eventClient(sessionId) {
  const sock = new WebSocket(`${wsBase}/v1/events?scopes=session:${sessionId}`, { headers });
  sock.on("message", () => {
    counters.eventFrames += 1;
  });
  sock.on("error", (e) => fail("event client", e));
  return sock;
}
function terminalClient(terminalId) {
  const sock = new WebSocket(`${wsBase}/v1/terminals/${terminalId}/stream`, { headers });
  sock.on("message", (data, isBinary) => {
    if (isBinary) counters.terminalBytes += data.length;
  });
  sock.on("open", () => sock.send(Buffer.from("echo fanout\r")));
  sock.on("error", (e) => fail("terminal client", e));
  return sock;
}
async function fanoutPhase(deadline) {
  while (terminalIds.length === 0 && Date.now() < deadline) await sleep(200);
  const sessionId = sessionIds[0];
  const terminalId = terminalIds[0];
  const clients = [];
  for (let i = 0; i < CLIENTS; i++) clients.push(eventClient(sessionId), terminalClient(terminalId));
  while (Date.now() < deadline) {
    await sleep(2000);
    // flap: drop one of each, reconnect
    // flap only sockets that are open; tearing down a half-open one is our artefact, not the daemon
    const ev = clients.shift();
    const tm = clients.shift();
    for (const c of [ev, tm])
      if (c && c.readyState === WebSocket.OPEN) c.terminate();
      else c?.once("open", () => c.terminate());
    clients.push(eventClient(sessionId), terminalClient(terminalId));
    counters.reconnects += 2;
  }
  for (const c of clients) c.terminate();
}

// ---- sampling
function childProcesses() {
  try {
    if (win) {
      const out = execFileSync(
        "powershell",
        [
          "-NoProfile",
          "-Command",
          `(Get-CimInstance Win32_Process -Filter "ParentProcessId=${process.pid}").Count`,
        ],
        { encoding: "utf8", windowsHide: true },
      );
      return Number(out.trim()) || 0;
    }
    const out = execFileSync("pgrep", ["-P", String(process.pid)], { encoding: "utf8" });
    return out.split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
}
function childList() {
  try {
    if (win) {
      const out = execFileSync(
        "powershell",
        [
          "-NoProfile",
          "-Command",
          `Get-CimInstance Win32_Process -Filter "ParentProcessId=${process.pid}" | ForEach-Object { $_.Name + " " + ($_.CommandLine -replace "s+", " ").Substring(0, [Math]::Min(90, ($_.CommandLine -replace "s+", " ").Length)) }`,
        ],
        { encoding: "utf8", windowsHide: true },
      );
      return out
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
    }
    const out = execFileSync("ps", ["-o", "pid=,args=", "--ppid", String(process.pid)], { encoding: "utf8" });
    return out
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}
function summariseChildren(label) {
  const groups = new Map();
  for (const line of childList()) {
    const key = line.includes("fake-pi")
      ? "fake-pi runner"
      : /Date.now|tick/.test(line)
        ? "terminal spew"
        : line.split(" ")[0];
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }
  console.log(`${label} children by kind: ${JSON.stringify([...groups])}`);
}
const samples = [];
function sample(label) {
  global.gc?.(); // with --expose-gc: measure retained memory, not garbage waiting for a collection
  const m = process.memoryUsage();
  const s = {
    t: Math.round((Date.now() - started) / 1000),
    rssMb: +(m.rss / 1048576).toFixed(1),
    heapMb: +(m.heapUsed / 1048576).toFixed(1),
    heapTotalMb: +(m.heapTotal / 1048576).toFixed(1),
    extMb: +(m.external / 1048576).toFixed(1),
    handles: process.getActiveResourcesInfo().length,
    children: childProcesses(),
    runners: daemon.host.list().filter((x) => x.live).length,
    terminals: daemon.terminals.list().filter((x) => x.status === "running").length,
    events: daemon.host.log.replay(0).events.length,
  };
  samples.push(s);
  console.log(
    `${label.padEnd(6)} t=${String(s.t).padStart(4)}s rss=${s.rssMb}MB heap=${s.heapMb}/${s.heapTotalMb}MB ext=${s.extMb}MB handles=${s.handles} children=${s.children} runners=${s.runners} terminals=${s.terminals} ring=${s.events} prompts=${counters.prompts} crashes=${counters.crashes} evictions=${counters.evictions} reconnects=${counters.reconnects} termKB=${Math.round(counters.terminalBytes / 1024)} events=${counters.eventFrames} errors=${counters.errors}`,
  );
}

const started = Date.now();
const deadline = started + MINUTES * 60_000;
console.log(
  `soak: ${MINUTES} min, ${SESSIONS} runners, ${TERMINALS} terminals, ${CLIENTS}x2 clients, pid ${process.pid}, home ${root}`,
);
sample("start");
const ticker = setInterval(() => sample("tick"), 10_000);
await Promise.all([runnersPhase(deadline), terminalsPhase(deadline), fanoutPhase(deadline)]);
clearInterval(ticker);
sample("end");
summariseChildren("before stop");

// ---- teardown and verdict
await daemon.stop("test");
await sleep(1500);
const orphans = childProcesses();
summariseChildren("after stop");
const first = samples[1] ?? samples[0];
const last = samples[samples.length - 1];
const growth = last.rssMb / Math.max(1, first.rssMb);
console.log(
  `\nafter stop: children=${orphans} rss=${(process.memoryUsage().rss / 1048576).toFixed(1)}MB handles=${process.getActiveResourcesInfo().length}`,
);
console.log(
  `rss growth over the run: x${growth.toFixed(2)} (${first.rssMb} → ${last.rssMb} MB); ring stayed at ${last.events} events`,
);
if (errors.length) console.log(`errors (${counters.errors}):\n  ${errors.join("\n  ")}`);
rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
const bad = orphans > 0 || growth > 1.5;
console.log(bad ? "SOAK FAILED" : "soak ok");
process.exit(bad ? 1 : 0);
