#!/usr/bin/env node

// Release artifacts (README "Installation"):
//   node scripts/release/build.mjs tgz           -> release/pi-daemon-<v>.tgz  (self-contained npm tarball)
//   node scripts/release/build.mjs win-portable  -> release/pi-daemon-<v>-win-x64.zip (node.exe + the package)
//   node scripts/release/build.mjs checksums     -> release/SHA256SUMS
//   node scripts/release/build.mjs all
// The tarball bundles the contract package and typebox, so `npm i -g <tgz>` works on a machine
// that has never seen this registry scope, and the Windows zip needs nothing but itself.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const daemonDir = path.join(root, "packages", "daemon");
const contractDir = path.join(root, "packages", "contract");
const releaseDir = path.join(root, "release");
const pkg = JSON.parse(readFileSync(path.join(daemonDir, "package.json"), "utf8"));
const version = pkg.version;
// npm without a shell: the npm-cli.js beside this node, run by this node. (npm.cmd needs a shell
// on Windows, and Node warns about shell + argv.)
const npmCli = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
const npmCmd = existsSync(npmCli) ? process.execPath : process.platform === "win32" ? "npm.cmd" : "npm";
const npmArgs = (args) => (npmCmd === process.execPath ? [npmCli, ...args] : args);
// Windows ships bsdtar in System32, which reads and writes zips. Git Bash puts GNU tar first on
// PATH, which does neither, and PowerShell's Expand-Archive takes minutes on 1 600 small files.
const tarCmd =
  process.platform === "win32"
    ? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe")
    : "tar";
// npm on Windows is a .cmd shim, which needs a shell; nothing else does.
const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, {
    stdio: "inherit",
    cwd: root,
    shell: cmd === "npm.cmd",
    ...opts,
  });

function vendorBundled() {
  // npm pack bundles only what sits in the package's own node_modules; workspaces hoist, so copy.
  const nm = path.join(daemonDir, "node_modules");
  const targets = {
    "@coresoft-hq/pi-daemon-contract": { from: contractDir, files: ["package.json", "dist", "README.md"] },
    typebox: { from: path.join(root, "node_modules", "typebox"), files: null },
  };
  for (const [name, t] of Object.entries(targets)) {
    const dest = path.join(nm, ...name.split("/"));
    rmSync(dest, { recursive: true, force: true });
    mkdirSync(dest, { recursive: true });
    for (const f of t.files ?? readdirSync(t.from)) {
      if (f === "node_modules") continue;
      cpSync(path.join(t.from, f), path.join(dest, f), { recursive: true });
    }
  }
  return () => {
    for (const name of Object.keys(targets))
      rmSync(path.join(nm, ...name.split("/")), { recursive: true, force: true });
  };
}

export function buildTgz() {
  if (!existsSync(path.join(daemonDir, "dist", "cli", "main.js"))) run(npmCmd, npmArgs(["run", "build"]));
  mkdirSync(releaseDir, { recursive: true });
  const cleanup = vendorBundled();
  try {
    run(npmCmd, npmArgs(["pack", "-w", "packages/daemon", "--pack-destination", releaseDir]));
  } finally {
    cleanup();
  }
  const tgz = path.join(releaseDir, `pi-daemon-${version}.tgz`);
  if (!existsSync(tgz)) throw new Error(`expected ${tgz}`);
  console.log(`built ${tgz}`);
  return tgz;
}

async function latestNode(major = 22) {
  const res = await fetch("https://nodejs.org/dist/index.json");
  const list = await res.json();
  const hit = list.find((e) => e.version.startsWith(`v${major}.`));
  if (!hit) throw new Error(`no Node ${major} release listed`);
  return hit.version.slice(1);
}

export async function buildWindowsPortable() {
  const tgz = path.join(releaseDir, `pi-daemon-${version}.tgz`);
  if (!existsSync(tgz)) buildTgz();
  const nodeVersion = process.env.PI_DAEMON_NODE_VERSION ?? (await latestNode(22));
  const stage = path.join(releaseDir, "stage-win-x64");
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });

  // node.exe from the official zip
  const zipName = `node-v${nodeVersion}-win-x64.zip`;
  const zipPath = path.join(releaseDir, zipName);
  if (!existsSync(zipPath)) {
    console.log(`downloading ${zipName}`);
    const res = await fetch(`https://nodejs.org/dist/v${nodeVersion}/${zipName}`);
    if (!res.ok) throw new Error(`node download failed: ${res.status}`);
    writeFileSync(zipPath, Buffer.from(await res.arrayBuffer()));
  }
  const unzipDir = path.join(releaseDir, "node-win-x64");
  rmSync(unzipDir, { recursive: true, force: true });
  mkdirSync(unzipDir, { recursive: true });
  run(tarCmd, ["-xf", zipPath, "-C", unzipDir]);
  const nodeRoot = path.join(unzipDir, `node-v${nodeVersion}-win-x64`);
  cpSync(path.join(nodeRoot, "node.exe"), path.join(stage, "node.exe"));
  cpSync(path.join(nodeRoot, "LICENSE"), path.join(stage, "LICENSE.node"));

  // the package, installed for win32-x64 so the ConPTY prebuild is the one that ships
  run(
    npmCmd,
    npmArgs([
      "install",
      "--prefix",
      path.join(stage, "app"),
      "--omit=dev",
      "--no-audit",
      "--no-fund",
      "--os=win32",
      "--cpu=x64",
      "--ignore-scripts",
      tgz,
    ]),
  );
  writeFileSync(
    path.join(stage, "pi-daemon.cmd"),
    [
      "@echo off",
      "setlocal",
      '"%~dp0node.exe" "%~dp0app\\node_modules\\pi-daemon\\dist\\cli\\main.js" %*',
      "exit /b %ERRORLEVEL%",
    ].join("\r\n") + "\r\n",
  );
  cpSync(path.join(root, "LICENSE"), path.join(stage, "LICENSE"), { force: true });
  cpSync(path.join(root, "README.md"), path.join(stage, "README.md"));

  const zipOut = path.join(releaseDir, `pi-daemon-${version}-win-x64.zip`);
  rmSync(zipOut, { force: true });
  run(tarCmd, ["-a", "-cf", zipOut, "-C", stage, "."]);
  rmSync(stage, { recursive: true, force: true });
  rmSync(unzipDir, { recursive: true, force: true });
  console.log(`built ${zipOut} (node ${nodeVersion})`);
  return zipOut;
}

export function checksums() {
  const lines = [];
  for (const f of readdirSync(releaseDir).sort()) {
    if (!/\.(tgz|zip)$/.test(f) || f.startsWith("node-v")) continue;
    const hash = createHash("sha256")
      .update(readFileSync(path.join(releaseDir, f)))
      .digest("hex");
    lines.push(`${hash}  ${f}`);
  }
  writeFileSync(path.join(releaseDir, "SHA256SUMS"), `${lines.join("\n")}\n`);
  console.log(lines.join("\n"));
}

const what = process.argv[2] ?? "all";
if (what === "tgz" || what === "all") buildTgz();
if (what === "win-portable" || what === "all") await buildWindowsPortable();
if (what === "checksums" || what === "all") checksums();
if (!["tgz", "win-portable", "checksums", "all"].includes(what)) {
  console.error("usage: build.mjs tgz | win-portable | checksums | all");
  process.exit(2);
}
