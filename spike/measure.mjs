// M0 item 6: what a runner costs. Spawn latency, RSS idle, RSS after a turn,
// and RSS across five concurrent runners. No network except one short prompt.

import { mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { Runner } from "./runner.mjs";

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const ws = path.join(here, "tmp", "workspace");
mkdirSync(ws, { recursive: true });
const EXT = path.join(here, "ext", "spike-ext.ts");
const ARGS = ["--no-extensions", "-e", EXT, "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--session-dir", path.join(ws, ".pi-sessions")];
const log = (...a) => console.log(...a);

function rssMb(pid) {
  if (process.platform === "win32") {
    const out = spawnSync("powershell.exe", ["-NoProfile", "-Command", `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).WorkingSet64`], { encoding: "utf8" }).stdout.trim();
    return out ? Math.round(Number(out) / 1024 / 1024) : NaN;
  }
  const out = spawnSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim();
  return out ? Math.round(Number(out) / 1024) : NaN;
}

async function spawnOne() {
  const t0 = performance.now();
  const r = new Runner({ cwd: ws, args: ARGS }).start();
  await r.send({ type: "get_state" });
  return { r, ms: Math.round(performance.now() - t0) };
}

async function main() {
  log("1. one runner, idle");
  const { r, ms } = await spawnOne();
  await new Promise((res) => setTimeout(res, 1500));
  log(`   spawn-to-get_state ${ms} ms; RSS idle ~${rssMb(r.pid)} MB (pid ${r.pid})`);

  log("2. same runner after one short turn");
  const t1 = performance.now();
  let first = null;
  r.on("event", (e) => { if (first === null && e.type === "message_update") first = Math.round(performance.now() - t1); });
  await r.send({ type: "prompt", message: "Reply with the single word OK." });
  await r.waitForEvent("agent_settled");
  await new Promise((res) => setTimeout(res, 1000));
  log(`   first token ${first} ms; RSS after a turn ~${rssMb(r.pid)} MB`);

  log("3. five concurrent runners, idle");
  const t2 = performance.now();
  const five = await Promise.all(Array.from({ length: 5 }, spawnOne));
  const wall = Math.round(performance.now() - t2);
  await new Promise((res) => setTimeout(res, 2000));
  const sizes = five.map(({ r: x }) => rssMb(x.pid));
  log(`   spawned 5 in ${wall} ms wall (individual: ${five.map((f) => f.ms).join(", ")} ms)`);
  log(`   RSS each: ${sizes.join(", ")} MB; total ~${sizes.reduce((a, b) => a + (b || 0), 0)} MB`);

  log("4. kill all, confirm gone");
  for (const { r: x } of five) x.kill();
  r.kill();
  await new Promise((res) => setTimeout(res, 1500));
  const alive = [r, ...five.map((f) => f.r)].filter((x) => Number.isFinite(rssMb(x.pid)));
  log(`   still alive after kill: ${alive.length}`);
  process.exit(0);
}

main().catch((e) => { console.error("MEASURE FAILED:", e); process.exit(1); });
