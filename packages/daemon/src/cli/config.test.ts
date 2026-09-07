import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { appDirs } from "../os/paths.ts";
import {
  ConfigError,
  configFile,
  DEFAULT_CONFIG,
  getPath,
  loadConfig,
  mergeConfig,
  parseConfigValue,
  readConfigDocument,
  setPath,
  validateConfig,
  writeConfigDocument,
} from "./config.ts";

function home(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "pid-config-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return appDirs("pi-daemon", { PI_DAEMON_HOME: dir });
}

test("defaults are valid, and a missing file is the defaults", (t) => {
  assert.deepEqual(validateConfig(DEFAULT_CONFIG), []);
  const dirs = home(t);
  assert.deepEqual(loadConfig(dirs), DEFAULT_CONFIG);
});

test("merge names unknown keys and wrong shapes; validate names ranges", () => {
  const problems: string[] = [];
  const c = mergeConfig({ port: 9000, limits: { maxRunners: 2 }, nope: 1, pi: "x" }, problems);
  assert.equal(c.port, 9000);
  assert.equal(c.limits.maxRunners, 2);
  assert.equal(c.limits.maxTerminals, 16, "untouched siblings keep their defaults");
  assert.deepEqual(problems, ["nope: unknown key", "pi: expected an object"]);
  const bad = mergeConfig({
    port: 70000,
    tls: "off",
    bind: "0.0.0.0",
    log: { level: "loud" },
    pi: { trust: "maybe" },
  });
  const v = validateConfig(bad);
  assert.ok(v.some((p) => p.startsWith("port:")));
  assert.ok(v.some((p) => p.startsWith("tls: off is only allowed with bind: loopback")));
  assert.ok(v.some((p) => p.startsWith("log.level:")));
  assert.ok(v.some((p) => p.startsWith("pi.trust:")));
});

test("load reads the file, reports every problem at once, and edits round-trip through dot paths", (t) => {
  const dirs = home(t);
  writeConfigDocument(dirs, { port: 9001, terminals: { enabled: false } });
  const c = loadConfig(dirs);
  assert.equal(c.port, 9001);
  assert.equal(c.terminals.enabled, false);
  assert.equal(c.files.write, true);

  const doc = setPath(readConfigDocument(dirs), "limits.maxTerminals", 3);
  assert.equal(getPath(doc, "limits.maxTerminals"), 3);
  assert.equal(getPath(doc, "port"), 9001);
  writeConfigDocument(dirs, setPath(doc, "port", undefined));
  assert.equal(loadConfig(dirs).port, 8790, "unset falls back to the default");
  assert.equal(loadConfig(dirs).limits.maxTerminals, 3);

  writeFileSync(configFile(dirs), JSON.stringify({ port: "eight", bogus: true }));
  assert.throws(
    () => loadConfig(dirs),
    (e: unknown) =>
      e instanceof ConfigError && e.problems.length === 2 && e.problems[0] === "bogus: unknown key",
  );
  writeFileSync(configFile(dirs), "{not json");
  assert.throws(() => loadConfig(dirs), ConfigError);
});

test("config set values: JSON when it parses, the literal string otherwise", () => {
  assert.equal(parseConfigValue("9000"), 9000);
  assert.equal(parseConfigValue("true"), true);
  assert.deepEqual(parseConfigValue('["a","b"]'), ["a", "b"]);
  assert.equal(parseConfigValue("tailscale"), "tailscale");
  assert.equal(parseConfigValue("null"), null);
});
