import assert from "node:assert/strict";
import { test } from "node:test";
import { platform } from "./paths.ts";
import { findOnPath, killTree, pidAlive, resolvePiLauncher, spawnArgv, userShell } from "./spawn.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("findOnPath finds node and honours PATHEXT on Windows", () => {
  const found = findOnPath("node");
  assert.ok(found, "node should be on PATH");
  if (platform === "win32") assert.match(found, /\.exe$/i);
});

test("resolvePiLauncher: PI_DAEMON_PI pointing at a JS entry runs under our node", () => {
  const l = resolvePiLauncher({ PI_DAEMON_PI: "/some/where/cli.js", PATH: "" });
  assert.deepEqual(l, {
    command: process.execPath,
    prefix: ["/some/where/cli.js"],
    source: "env",
    entry: "/some/where/cli.js",
  });
});

test("resolvePiLauncher: nothing on PATH is null, not a throw", () => {
  assert.equal(resolvePiLauncher({ PATH: "" }), null);
});

test("userShell builds argv, never a shell string", () => {
  const sh = userShell();
  const argv = sh.argsFor("echo 'hi there' && ls");
  assert.ok(argv.length >= 2);
  assert.equal(argv.at(-1), "echo 'hi there' && ls", "the user's literal command is one argv element");
});

test("killTree kills a child and its grandchild", async () => {
  // Parent spawns a grandchild that lives forever; both must die.
  const script = `
    const { spawn } = require("node:child_process");
    const c = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    process.stdout.write(String(c.pid) + "\\n");
    setInterval(() => {}, 1000);
  `;
  const parent = spawnArgv(process.execPath, ["-e", script], { ownGroup: true });
  const grandchildPid = await new Promise<number>((resolve) => {
    let buf = "";
    parent.stdout?.on("data", (d: Buffer) => {
      buf += d.toString();
      const m = buf.match(/^(\d+)\n/);
      if (m) resolve(Number(m[1]));
    });
  });
  assert.equal(pidAlive(grandchildPid), true);
  assert.equal(pidAlive(parent.pid as number), true);

  killTree(parent.pid as number);
  for (let i = 0; i < 50 && (pidAlive(grandchildPid) || pidAlive(parent.pid as number)); i++)
    await sleep(100);
  assert.equal(pidAlive(parent.pid as number), false, "parent is dead");
  assert.equal(pidAlive(grandchildPid), false, "grandchild is dead");
});

test("pidAlive is false for an impossible pid", () => {
  assert.equal(pidAlive(2 ** 22 + 12345), false);
  assert.equal(pidAlive(-1), false);
});
