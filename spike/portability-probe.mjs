// M0 item 9 (probe, not gate): can a pi session file be re-homed under a
// different workspace path and still open? Decides how much "context intact"
// a future workspace move (spec §11.9) can promise.
//
// Uses an isolated --session-dir so nothing touches ~/.pi/agent/sessions.

import { mkdirSync, readdirSync, copyFileSync, statSync, readFileSync } from "node:fs";
import path from "node:path";
import { Runner } from "./runner.mjs";

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const tmp = path.join(here, "tmp", "portability");
const wsA = path.join(tmp, "workspace-a");
const wsB = path.join(tmp, "workspace-b");
const sessionsA = path.join(tmp, "sessions-a");
const sessionsB = path.join(tmp, "sessions-b");
for (const d of [wsA, wsB, sessionsA, sessionsB]) mkdirSync(d, { recursive: true });

const log = (...a) => console.log(...a);
const isolate = ["--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-tools"];

function findJsonl(root) {
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".jsonl")) out.push(p);
    }
  };
  walk(root);
  return out;
}

async function main() {
  log("1. create a session in workspace A and give it one exchange");
  const a = new Runner({ cwd: wsA, args: [...isolate, "--session-dir", sessionsA] }).start();
  a.on("stderr", (s) => process.stderr.write(`[A] ${s}`));
  const st = await a.send({ type: "get_state" });
  log(`   sessionId=${st.data.sessionId} file=${st.data.sessionFile}`);
  await a.send({ type: "prompt", message: "Reply with exactly the single word PORTABLE and nothing else." });
  await a.waitForEvent("agent_settled");
  const msgsA = (await a.send({ type: "get_messages" })).data.messages;
  log(`   messages after prompt: ${msgsA.length}`);
  a.kill();
  await new Promise((r) => a.once("exit", r));

  const files = findJsonl(sessionsA);
  log(`   session files under sessions-a: ${files.map((f) => path.relative(sessionsA, f)).join(", ")}`);
  const src = files.find((f) => f.includes(st.data.sessionId));
  const header = JSON.parse(readFileSync(src, "utf8").split("\n")[0]);
  log(`   header: ${JSON.stringify({ ...header, id: header.id ?? "?" }).slice(0, 200)}`);

  log("2. re-home: copy under the directory key pi would use for workspace B");
  const relDir = path.relative(sessionsA, path.dirname(src)); // e.g. --C-...-workspace-a--
  const keyB = relDir.replace(/workspace-a/g, "workspace-b");
  const destDir = path.join(sessionsB, keyB);
  mkdirSync(destDir, { recursive: true });
  const dest = path.join(destDir, path.basename(src));
  copyFileSync(src, dest);
  log(`   copied to ${path.relative(sessionsB, dest)} (${statSync(dest).size} bytes)`);

  async function tryOpen(label, args) {
    log(label);
    const r = new Runner({ cwd: wsB, args }).start();
    let err = "";
    const raw = [];
    r.on("stderr", (s) => (err += s));
    r.on("protocol_error", (_e, line) => raw.push(line));
    r.on("exit", (e) => log(`   runner exit: ${JSON.stringify(e)}`));
    try {
      const stX = await r.send({ type: "get_state" });
      const msgsX = (await r.send({ type: "get_messages" })).data.messages;
      log(`   sessionId=${stX.data.sessionId} same id: ${stX.data.sessionId === st.data.sessionId}`);
      log(`   file=${stX.data.sessionFile}`);
      log(`   messages visible: ${msgsX.length} (A had ${msgsA.length})`);
      r.kill();
      await new Promise((res) => r.once("exit", res));
      return stX.data.sessionId === st.data.sessionId && msgsX.length === msgsA.length;
    } catch (e) {
      log(`   failed: ${e.message}`);
      return false;
    } finally {
      if (err.trim()) log(`   stderr: ${err.trim().slice(0, 600)}`);
      if (raw.length) log(`   non-JSON stdout: ${raw.join(" | ").slice(0, 600)}`);
    }
  }

  const byId = await tryOpen("3. open it from workspace B by id, with --session-dir pointing at sessions-b",
    [...isolate, "--session-dir", sessionsB, "--session", st.data.sessionId]);
  const byPath = await tryOpen("4. open the same file by explicit path from workspace B",
    [...isolate, "--session-dir", sessionsB, "--session", dest]);
  const byPathNoDir = await tryOpen("5. open by explicit path with NO --session-dir (default store untouched, file lives elsewhere)",
    [...isolate, "--session", dest]);
  log(`   (5) re-home by explicit path without a session dir: ${byPathNoDir ? "WORKS" : "does not work"}`);
  log(`\nre-home by id: ${byId ? "WORKS" : "does not work"}; by explicit path: ${byPath ? "WORKS" : "does not work"}`);
  process.exit(0);
}

main().catch((e) => {
  console.error("PROBE FAILED:", e);
  process.exit(1);
});
