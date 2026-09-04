import { mkdirSync } from "node:fs";
import path from "node:path";
import { Runner } from "./runner.mjs";
const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const ws = path.join(here, "tmp", "workspace"); mkdirSync(ws, { recursive: true });
const EXT = path.join(here, "ext", "spike-ext.ts");
const variants = {
  "bare (--no-extensions --no-tools --no-session)": ["--no-extensions", "--no-tools", "--no-session"],
  "bare + -e spike-ext.ts": ["--no-extensions", "-e", EXT, "--no-tools", "--no-session"],
  "server flags (isolate + ext + tools + session-dir)": ["--no-extensions", "-e", EXT, "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--session-dir", path.join(ws, ".pi-sessions")],
  "operator default (no flags)": [],
};
for (const [name, args] of Object.entries(variants)) {
  const t0 = performance.now();
  const r = new Runner({ cwd: ws, args }).start();
  let err = "";
  r.on("stderr", (s) => (err += s));
  try {
    await r.send({ type: "get_state" });
    console.log(`${Math.round(performance.now() - t0).toString().padStart(6)} ms  ${name}`);
  } catch (e) { console.log(`  FAIL  ${name}: ${e.message} ${err.slice(0, 200)}`); }
  r.kill(); await new Promise((res) => r.once("exit", res));
}
