import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { after, before, test } from "node:test";
import { connectLocal, listenLocal, localEndpointPath } from "./ipc.ts";
import { platform, tmpDir } from "./paths.ts";

let dir: string;
before(() => {
  dir = mkdtempSync(path.join(tmpDir(), "pi-daemon-ipc-"));
});
after(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("endpoint path is a named pipe on Windows and a socket file elsewhere", () => {
  const p = localEndpointPath(dir);
  if (platform === "win32") assert.match(p, /^\\\\\.\\pipe\\pi-daemon-/);
  else assert.ok(p.endsWith("pi-daemon.sock"));
});

test("the local endpoint accepts net.connect(path) — the seam pi-client's transport uses", async () => {
  const endpoint = localEndpointPath(dir, `pi-daemon-test-${process.pid}`);
  const server = net.createServer((sock) => sock.pipe(sock));
  await listenLocal(server, endpoint);
  try {
    const client = connectLocal(endpoint);
    const echoed = await new Promise<string>((resolve, reject) => {
      client.once("connect", () => client.write("ping"));
      client.once("data", (d) => resolve(d.toString()));
      client.once("error", reject);
    });
    assert.equal(echoed, "ping");
    client.destroy();
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("a stale socket file is cleared before listening", { skip: platform === "win32" }, async () => {
  const endpoint = localEndpointPath(dir, `stale-${process.pid}`);
  const { writeFileSync } = await import("node:fs");
  writeFileSync(endpoint, "");
  const server = net.createServer();
  await listenLocal(server, endpoint);
  await new Promise<void>((r) => server.close(() => r()));
});
