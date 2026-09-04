// M0 items 7 and 8: the PTY addon loads from a prebuild, and a screen kept in
// @xterm/headless can be serialised to VT bytes that reproduce it in another
// emulator. Here the "other emulator" is a second headless instance; the
// browser check (xterm.js + ghostty-web) is a manual step recorded separately.

import xtermHeadless from "@xterm/headless";
const { Terminal } = xtermHeadless;
import serializeAddon from "@xterm/addon-serialize";
const { SerializeAddon } = serializeAddon;

const log = (...a) => console.log(...a);

function write(term, data) {
  return new Promise((r) => term.write(data, r));
}

function screenLines(term) {
  const buf = term.buffer.active;
  const lines = [];
  for (let i = 0; i < buf.length; i++) lines.push(buf.getLine(i)?.translateToString(true) ?? "");
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

async function ptyOutput() {
  const pty = await import("node-pty");
  const isWin = process.platform === "win32";
  const shell = isWin ? "powershell.exe" : "bash";
  const args = isWin
    ? ["-NoProfile", "-Command", "Write-Host 'red' -ForegroundColor Red; Write-Host 'green' -ForegroundColor Green; 1..30 | % { \"line $_\" }; exit"]
    : ["-lc", "printf '\\e[31mred\\e[0m\\n\\e[32mgreen\\e[0m\\n'; for i in $(seq 1 30); do echo line $i; done"];
  const t0 = performance.now();
  const p = pty.spawn(shell, args, { cols: 80, rows: 24, cwd: process.cwd(), env: process.env, name: "xterm-256color" });
  let out = "";
  p.onData((d) => (out += d));
  await new Promise((r) => p.onExit(r));
  return { out, ms: Math.round(performance.now() - t0) };
}

async function main() {
  log("1. node-pty loads and a shell round-trips");
  const { out, ms } = await ptyOutput();
  log(`   ${out.length} bytes of PTY output in ${ms} ms, contains 'line 30': ${out.includes("line 30")}`);

  log("2. headless emulator keeps the screen; serialise it");
  const a = new Terminal({ cols: 80, rows: 24, scrollback: 1000, allowProposedApi: true });
  const ser = new SerializeAddon();
  a.loadAddon(ser);
  await write(a, out);
  const snapshot = ser.serialize({ scrollback: 1000 });
  log(`   live buffer: ${a.buffer.active.length} lines; snapshot: ${snapshot.length} bytes (raw output was ${out.length})`);

  log("3. replay the snapshot into a fresh emulator and compare");
  const b = new Terminal({ cols: 80, rows: 24, scrollback: 1000, allowProposedApi: true });
  await write(b, snapshot);
  const la = screenLines(a);
  const lb = screenLines(b);
  let same = la.length === lb.length;
  let firstDiff = -1;
  for (let i = 0; same && i < la.length; i++) if (la[i] !== lb[i]) { same = false; firstDiff = i; }
  log(`   lines: ${la.length} vs ${lb.length}; identical: ${same}${firstDiff >= 0 ? ` (first diff at ${firstDiff})` : ""}`);
  if (!same && firstDiff >= 0) log(`   a: ${JSON.stringify(la[firstDiff])}\n   b: ${JSON.stringify(lb[firstDiff])}`);

  log("4. colour survives serialisation");
  const cellA = a.buffer.active.getLine(0)?.getCell(0);
  const cellB = b.buffer.active.getLine(0)?.getCell(0);
  log(`   first cell fg: ${cellA?.getFgColor()} vs ${cellB?.getFgColor()}`);

  log("5. resize reflow");
  a.resize(40, 24);
  b.resize(40, 24);
  log(`   after resize to 40 cols, both buffers ${a.buffer.active.length} / ${b.buffer.active.length} lines`);

  log("6. memory: one idle headless terminal with 10k scrollback");
  const before = process.memoryUsage().heapUsed;
  const big = new Terminal({ cols: 120, rows: 40, scrollback: 10_000, allowProposedApi: true });
  await write(big, Array.from({ length: 12_000 }, (_, i) => `line ${i} ${"x".repeat(60)}\r\n`).join(""));
  const after = process.memoryUsage().heapUsed;
  log(`   ~${Math.round((after - before) / 1024 / 1024)} MB heap for a full 10k-line scrollback at 120 cols`);

  const ok = out.includes("line 30") && same;
  log(ok ? "\nPASS" : "\nFAIL");
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error("FAILED:", e);
  process.exit(1);
});
