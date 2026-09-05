import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { appDirs, piAgentDir, piSessionsDir } from "./paths.ts";

test("Windows uses LOCALAPPDATA", () => {
  const d = appDirs("pi-daemon", { LOCALAPPDATA: "C:\\Users\\o\\AppData\\Local" }, "C:\\Users\\o", "win32");
  assert.equal(d.data, path.join("C:\\Users\\o\\AppData\\Local", "pi-daemon"));
  assert.equal(d.logs, path.join(d.data, "logs"));
});

test("macOS uses Application Support and Library/Logs", () => {
  const d = appDirs("pi-daemon", {}, "/Users/o", "darwin");
  assert.equal(d.data, path.join("/Users/o", "Library", "Application Support", "pi-daemon"));
  assert.equal(d.logs, path.join("/Users/o", "Library", "Logs", "pi-daemon"));
});

test("Linux honours XDG variables and falls back to the defaults", () => {
  const d = appDirs(
    "pi-daemon",
    { XDG_STATE_HOME: "/xdg/state", XDG_CONFIG_HOME: "/xdg/config" },
    "/home/o",
    "linux",
  );
  assert.equal(d.state, path.join("/xdg/state", "pi-daemon"));
  assert.equal(d.config, path.join("/xdg/config", "pi-daemon"));
  assert.equal(d.data, path.join("/home/o", ".local", "share", "pi-daemon"));
  assert.equal(d.logs, path.join("/xdg/state", "pi-daemon", "logs"));
});

test("PI_DAEMON_HOME overrides everything", () => {
  const d = appDirs("pi-daemon", { PI_DAEMON_HOME: "/tmp/pd" }, "/home/o", "linux");
  assert.equal(d.data, path.resolve("/tmp/pd"));
  assert.equal(d.config, path.resolve("/tmp/pd"));
});

test("pi's agent and sessions directories", () => {
  assert.equal(piAgentDir("/home/o"), path.join("/home/o", ".pi", "agent"));
  assert.equal(piSessionsDir(piAgentDir("/home/o")), path.join("/home/o", ".pi", "agent", "sessions"));
  assert.equal(piAgentDir("/home/o", "/custom"), path.resolve("/custom"));
});
