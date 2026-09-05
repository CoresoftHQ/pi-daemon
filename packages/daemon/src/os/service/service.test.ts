import assert from "node:assert/strict";
import { test } from "node:test";
import { platform } from "../paths.ts";
import { serviceManager } from "./index.ts";
import { LaunchdServiceManager } from "./launchd.ts";
import { SystemdUserServiceManager } from "./systemd.ts";
import type { ServiceDefinition } from "./types.ts";
import { WindowsTaskServiceManager } from "./windows.ts";

const def: ServiceDefinition = {
  name: "pi-daemon-test",
  description: "pi-daemon test service",
  argv: [process.execPath, "/opt/pi daemon/cli.js", "serve", "--bind", "loopback"],
  cwd: "/home/o",
  env: { PI_DAEMON_HOME: "/home/o/.pd", WEIRD: "a b'c" },
  logFile: "/home/o/pd.log",
};

test("systemd unit renders ExecStart with quoting and the install target", () => {
  const unit = new SystemdUserServiceManager("/home/o/.config").render(def);
  assert.match(unit, /^\[Unit\]/m);
  assert.match(unit, /ExecStart=.* '\/opt\/pi daemon\/cli\.js' serve --bind loopback$/m);
  assert.match(unit, /Environment='WEIRD=a b'\\''c'/);
  assert.match(unit, /WantedBy=default\.target/);
  assert.match(unit, /KillMode=control-group/);
});

test("launchd plist renders label, arguments, KeepAlive, and escaped env", () => {
  const m = new LaunchdServiceManager("/Users/o", 501);
  const plist = m.render(def);
  assert.equal(m.label("pi-daemon-test"), "com.coresoft.pi-daemon-test");
  assert.match(plist, /<string>com\.coresoft\.pi-daemon-test<\/string>/);
  assert.match(plist, /<string>\/opt\/pi daemon\/cli\.js<\/string>/);
  assert.match(plist, /<key>KeepAlive<\/key>\s*<true\/>/);
  assert.match(plist, /<string>a b&apos;c<\/string>|<string>a b'c<\/string>/);
  assert.match(plist, /StandardOutPath/);
});

test("windows task command line quotes arguments with spaces", () => {
  const tr = new WindowsTaskServiceManager().render(def);
  assert.ok(tr.includes(`"/opt/pi daemon/cli.js"`));
  assert.ok(tr.endsWith("serve --bind loopback"));
});

test("serviceManager picks the adapter for this platform", () => {
  const m = serviceManager();
  const expected = platform === "win32" ? "windows-task" : platform === "darwin" ? "launchd" : "systemd-user";
  assert.equal(m.kind, expected);
});

test("install → status → uninstall round-trips on this platform", {
  skip:
    process.env.PI_DAEMON_SERVICE_TESTS !== "1"
      ? "set PI_DAEMON_SERVICE_TESTS=1 to register a real user service"
      : false,
}, async (t) => {
  const m = serviceManager();
  const name = `pi-daemon-ci-${process.pid}`;
  const real: ServiceDefinition = {
    name,
    description: "pi-daemon CI round-trip",
    argv: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
  };
  try {
    await m.install(real);
  } catch (err) {
    const msg = String((err as Error).message);
    if (/connect to bus|not been booted|Failed to connect|No such file/i.test(msg)) {
      t.skip(`no user service manager on this host: ${msg}`);
      return;
    }
    throw err;
  }
  try {
    const s = await m.status(name);
    assert.equal(s.installed, true, JSON.stringify(s));
  } finally {
    await m.uninstall(name);
  }
  const after = await m.status(name);
  assert.equal(after.installed, false, JSON.stringify(after));
});
