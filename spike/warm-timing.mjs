import path from "node:path";
import { Runner } from "./runner.mjs";
const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const ws = path.join(here, "tmp", "workspace");
for (const [name, args] of [["operator default (no flags), warm", []], ["operator default again", []], ["bare", ["--no-extensions", "--no-tools", "--no-session"]]]) {
  const t0 = performance.now();
  const r = new Runner({ cwd: ws, args }).start();
  try { await r.send({ type: "get_state" }); console.log(`${Math.round(performance.now() - t0).toString().padStart(6)} ms  ${name}`); }
  catch (e) { console.log(`  FAIL  ${name}: ${e.message}`); }
  r.kill(); await new Promise((res) => r.once("exit", res));
}
