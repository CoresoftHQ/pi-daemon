import path from "node:path";
import { Runner } from "./runner.mjs";
const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const ws = path.join(here, "tmp", "workspace");
const base = ["--no-extensions", "--no-tools", "--no-session"];
const variants = {
  "min.mjs (no imports)": [...base, "-e", path.join(here, "ext", "min.mjs")],
  "typebox-only.ts": [...base, "-e", path.join(here, "ext", "typebox-only.ts")],
  "typeimport-only.ts": [...base, "-e", path.join(here, "ext", "typeimport-only.ts")],
  "spike-ext.ts + --verbose": [...base, "-e", path.join(here, "ext", "spike-ext.ts"), "--verbose"],
};
for (const [name, args] of Object.entries(variants)) {
  const t0 = performance.now();
  const r = new Runner({ cwd: ws, args }).start();
  let err = "";
  r.on("stderr", (s) => (err += s));
  const raw = [];
  r.on("protocol_error", (_e, line) => raw.push(line));
  try { await r.send({ type: "get_state" }); console.log(`${Math.round(performance.now() - t0).toString().padStart(6)} ms  ${name}`); }
  catch (e) { console.log(`  FAIL  ${name}: ${e.message}`); }
  if (err.trim()) console.log(`        stderr: ${err.trim().replace(/\n/g, " | ").slice(0, 400)}`);
  if (raw.length) console.log(`        stdout(non-json): ${raw.join(" | ").slice(0, 400)}`);
  r.kill(); await new Promise((res) => r.once("exit", res));
}
