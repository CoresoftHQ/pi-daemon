// Import-boundary lint (spec §2.3). Three rules that rot silently if not enforced:
//   1. nothing outside src/runners may know pi exists
//   2. nothing outside src/os may branch on the operating system
//   3. nothing outside src/terminals may import node-pty
// Plus the layering: access → serve → sessions → runners, workspaces under sessions, os at the bottom.

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..", "packages", "daemon", "src");
const MODULES = ["os", "runners", "sessions", "workspaces", "serve", "access", "terminals", "cli"];
// Who may import whom (module → allowed module imports). `os` may import nothing.
const ALLOWED = {
  os: [],
  runners: ["os"],
  workspaces: ["os"],
  terminals: ["os"],
  sessions: ["os", "runners", "workspaces"],
  serve: ["os", "sessions", "workspaces", "terminals", "access"],
  access: ["os"],
  cli: ["os", "runners", "sessions", "workspaces", "serve", "access", "terminals"],
};

const files = [];
(function walk(dir) {
  for (const e of readdirSync(dir)) {
    const p = path.join(dir, e);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.ts$/.test(e) && !/\.d\.ts$/.test(e)) files.push(p);
  }
})(root);

const problems = [];
for (const file of files) {
  const rel = path.relative(root, file).split(path.sep);
  const mod = rel[0];
  const isTest = /\.test\.ts$/.test(file);
  const src = readFileSync(file, "utf8");

  for (const m of src.matchAll(/^\s*(?:import|export)[^'"]*from\s*["']([^"']+)["']/gm)) {
    const spec = m[1];
    if (/^(?:@earendil-works\/|.*pi-coding-agent)/.test(spec) && mod !== "runners" && mod !== "serve") {
      problems.push(`${file}: imports pi (${spec}) outside runners/serve`);
    }
    if (/^node-pty/.test(spec) && mod !== "terminals")
      problems.push(`${file}: imports node-pty outside terminals`);
    if (spec.startsWith(".")) {
      const target = path.resolve(path.dirname(file), spec);
      const trel = path.relative(root, target).split(path.sep);
      const tmod = trel[0];
      if (MODULES.includes(tmod) && tmod !== mod && !(ALLOWED[mod] ?? []).includes(tmod)) {
        problems.push(`${file}: ${mod} may not import ${tmod} (${spec})`);
      }
    }
  }
  if (mod !== "os" && !isTest && /process\.platform|from\s*["']node:os["']|platform\(\)/.test(src)) {
    problems.push(`${file}: branches on the operating system outside os/`);
  }
}

if (problems.length) {
  console.error(`boundary violations:\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
console.log(`boundaries ok (${files.length} files)`);
