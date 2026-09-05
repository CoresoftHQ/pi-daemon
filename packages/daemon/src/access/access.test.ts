import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import http from "node:http";
import type net from "node:net";
import path from "node:path";
import type { TestContext } from "node:test";
import { after, before, test } from "node:test";
import { encodeClientMessage } from "@earendil-works/pi-protocol";
import { platform, tmpDir } from "../os/paths.ts";
import { PiProtocolServer } from "../serve/pi-protocol/server.ts";
import { memoryPair } from "../serve/transport.ts";
import { singleRootResolver } from "../serve/workspace-resolver.ts";
import { SessionHost } from "../sessions/host.ts";
import type { AccessControl } from "./authenticate.ts";
import { authenticate, createUpgradeAuthenticator, hasRole } from "./authenticate.ts";
import { loadOrCreateIdentity } from "./daemon-identity.ts";
import { DeviceStore } from "./devices.ts";
import { createAccessRoutes } from "./http.ts";
import { PairingService } from "./pairing.ts";
import { RateLimiter } from "./ratelimit.ts";
import { identityFor, isTailnetAddress, parseStatus, tailnetStatus } from "./tailscale.ts";
import { ConnectTickets } from "./tickets.ts";
import { selfSignedMaterial, spkiFingerprint, tailscaleCertMaterial } from "./tls.ts";
import { hashSecret, mintToken, normaliseCrockford, parseToken, verifySecret } from "./tokens.ts";

let dir: string;
before(() => {
  dir = mkdtempSync(path.join(tmpDir(), "pi-daemon-access-"));
});
after(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/** A clock the tests move by hand. */
function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, tick: (ms: number) => (t += ms) };
}

function fakeReq(o: { auth?: string; url?: string; remote?: string } = {}): http.IncomingMessage {
  return {
    headers: o.auth ? { authorization: o.auth } : {},
    url: o.url ?? "/",
    socket: { remoteAddress: o.remote ?? "127.0.0.1" },
  } as unknown as http.IncomingMessage;
}

// ---------------------------------------------------------------- tokens

test("tokens: minted format, parse, hash at rest, constant-time verify", () => {
  const m = mintToken();
  assert.match(m.token, /^pid_[0-9A-Z]{16}_[A-Za-z0-9_-]{43}$/);
  const parsed = parseToken(m.token);
  assert.equal(parsed?.deviceId, m.deviceId);
  assert.equal(hashSecret(parsed?.secret ?? ""), m.secretHash);
  assert.equal(verifySecret(parsed?.secret ?? "", m.secretHash), true);
  assert.equal(verifySecret("wrong", m.secretHash), false);
  assert.equal(parseToken("nope"), null);
  assert.equal(parseToken(`pid_${m.deviceId}_short`), null);
});

test("Crockford normalisation forgives case, dashes, and the I/L/O confusions", () => {
  assert.equal(normaliseCrockford("k7m4-qp2x"), "K7M4QP2X");
  assert.equal(normaliseCrockford("ILO1"), "1101");
});

// ---------------------------------------------------------------- devices

test("device store: first device is owner, tokens verify, the file holds hashes only, revoke works", () => {
  const file = path.join(dir, "devices.json");
  const store = new DeviceStore(file, { now: () => 42 });
  const a = store.create({ name: "phone", platform: "ios" });
  const b = store.create({ name: "laptop", platform: "macos" });
  assert.equal(a.device.role, "owner");
  assert.equal(b.device.role, "member");
  assert.equal(store.verify(a.token)?.id, a.device.id);
  assert.equal(store.verify(`${a.token}x`), null);
  assert.equal(store.verify(`pid_NOPE00000000000_${"a".repeat(43)}`), null);

  const raw = readFileSync(file, "utf8");
  assert.ok(!raw.includes(a.token.split("_")[2] ?? "!"), "the secret is never written");
  assert.ok(raw.includes("secretHash"));
  if (platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600);

  const reloaded = new DeviceStore(file);
  assert.equal(reloaded.count, 2);
  assert.equal(reloaded.verify(b.token)?.name, "laptop");
  assert.equal(reloaded.revoke(b.device.id), true);
  assert.equal(reloaded.verify(b.token), null);
  assert.equal(reloaded.revoke("nope"), false);
  assert.deepEqual(
    reloaded.list().map((d) => d.id),
    [a.device.id],
  );
});

// ---------------------------------------------------------------- pairing

function pairingSetup(opts: { confirm?: () => Promise<boolean> } = {}) {
  const c = clock();
  const devices = new DeviceStore(path.join(dir, `pair-${Math.random().toString(36).slice(2)}.json`), {
    now: c.now,
  });
  const pairing = new PairingService({ devices, daemonId: "dm_TEST", now: c.now, confirm: opts.confirm });
  return { c, devices, pairing };
}

test("pairing: a code is single-use, expires after the TTL, and carries the fingerprint in its payload", async () => {
  const { c, pairing } = pairingSetup();
  const code = pairing.issue();
  assert.match(code.code, /^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
  const payload = pairing.payload({ host: "h.tailnet.ts.net", port: 8790, fingerprint: "ab12" });
  assert.deepEqual(payload, {
    v: 1,
    host: "h.tailnet.ts.net",
    port: 8790,
    fp: "ab12",
    code: code.code,
    daemonId: "dm_TEST",
  });

  const ok = await pairing.redeem({
    code: code.code.toLowerCase().replace("-", ""),
    deviceName: "phone",
    platform: "ios",
  });
  assert.ok(ok.ok);
  if (ok.ok) {
    assert.equal(ok.role, "owner");
    assert.match(ok.token, /^pid_/);
  }
  const again = await pairing.redeem({ code: code.code, deviceName: "x", platform: "y" });
  assert.deepEqual(again, { ok: false, reason: "no_active_code" });

  pairing.issue();
  c.tick(121_000);
  assert.equal(pairing.active(), null);
  const late = await pairing.redeem({ code: "AAAA-AAAA", deviceName: "x", platform: "y" });
  assert.equal(late.ok, false);
  assert.equal(pairing.payload({ host: "h", port: 1 }), null);
});

test("pairing: five wrong guesses kill the code; a confirm hook can decline", async () => {
  const { pairing } = pairingSetup({ confirm: async () => false });
  const code = pairing.issue();
  for (let i = 0; i < 4; i++)
    assert.deepEqual(await pairing.redeem({ code: "ZZZZ-ZZZZ", deviceName: "x", platform: "y" }), {
      ok: false,
      reason: "mismatch",
    });
  assert.deepEqual(await pairing.redeem({ code: "ZZZZ-ZZZZ", deviceName: "x", platform: "y" }), {
    ok: false,
    reason: "too_many_attempts",
  });
  assert.equal(pairing.active(), null);
  pairing.issue();
  const declined = await pairing.redeem({
    code: pairing.active()?.code ?? "",
    deviceName: "x",
    platform: "y",
  });
  assert.deepEqual(declined, { ok: false, reason: "declined" });
  assert.equal(pairing.active(), null, "a declined code is still consumed");
  void code;
});

// ---------------------------------------------------------------- tickets

test("connect tickets: single use, 30 s, bound to the peer", () => {
  const c = clock();
  const t = new ConnectTickets({ now: c.now });
  const { ticket } = t.mint("DEV1", "10.0.0.5");
  assert.equal(t.consume(ticket, "10.0.0.6"), null, "wrong peer");
  assert.equal(
    t.consume(ticket, "10.0.0.5"),
    null,
    "already consumed by the failed attempt — single use means single use",
  );
  const { ticket: t2 } = t.mint("DEV1", "10.0.0.5");
  c.tick(31_000);
  assert.equal(t.consume(t2, "10.0.0.5"), null, "expired");
  const { ticket: t3 } = t.mint("DEV1", "10.0.0.5");
  assert.deepEqual(t.consume(t3, "10.0.0.5"), { deviceId: "DEV1" });
  const { ticket: t4 } = t.mint("DEV2");
  t.dropDevice("DEV2");
  assert.equal(t.consume(t4), null, "revocation drops a device's tickets");
});

// ---------------------------------------------------------------- rate limiting

test("rate limiter: fixed window with peek and reset", () => {
  const c = clock();
  const r = new RateLimiter({ windowMs: 1000, max: 2, now: c.now });
  assert.equal(r.hit("k").allowed, true);
  assert.equal(r.hit("k").allowed, true);
  assert.equal(r.peek("k").allowed, false);
  const d = r.hit("k");
  assert.equal(d.allowed, false);
  assert.ok(d.retryAfterMs > 0 && d.retryAfterMs <= 1000);
  c.tick(1001);
  assert.equal(r.hit("k").allowed, true);
  r.reset("k");
  assert.equal(r.peek("k").remaining, 2);
});

// ---------------------------------------------------------------- tailscale

const STATUS_FIXTURE = {
  BackendState: "Running",
  Self: {
    DNSName: "coresoft-agent.tail3f0fb7.ts.net.",
    TailscaleIPs: ["100.64.209.32", "fd7a:115c:a1e0::9b38:d120"],
    UserID: 8723120806538003,
  },
  User: {
    "8723120806538003": { ID: 8723120806538003, LoginName: "azzlack@github", DisplayName: "Ove Andersen" },
    "42": { ID: 42, LoginName: "guest@example.com", DisplayName: "Guest" },
  },
  Peer: {
    a: {
      DNSName: "oves-imac.tail3f0fb7.ts.net.",
      TailscaleIPs: ["100.107.75.77", "fd7a:115c:a1e0::82c:4b4f"],
      UserID: 8723120806538003,
      Online: true,
    },
    b: { DNSName: "visitor.tail3f0fb7.ts.net.", TailscaleIPs: ["100.90.1.2"], UserID: 42, Online: false },
  },
};

test("tailscale status parses into addresses, names, and per-address identity", () => {
  const s = parseStatus(STATUS_FIXTURE);
  assert.equal(s.running, true);
  assert.deepEqual(s.ips, ["100.64.209.32", "fd7a:115c:a1e0::9b38:d120"]);
  assert.equal(s.dnsName, "coresoft-agent.tail3f0fb7.ts.net");
  assert.equal(identityFor(s, "::ffff:100.107.75.77")?.loginName, "azzlack@github");
  assert.equal(identityFor(s, "100.90.1.2")?.displayName, "Guest");
  assert.equal(
    identityFor(s, "100.64.209.32")?.loginName,
    "azzlack@github",
    "the daemon's own address resolves too",
  );
  assert.equal(identityFor(s, "192.168.1.1"), null);
  assert.equal(isTailnetAddress("100.100.5.5"), true);
  assert.equal(isTailnetAddress("100.200.5.5"), false);
  assert.equal(isTailnetAddress("::ffff:100.64.0.1"), true);
  assert.equal(isTailnetAddress("fd7a:115c:a1e0::1"), true);
  assert.equal(isTailnetAddress("10.0.0.1"), false);
});

test("tailnetStatus is null when the CLI is missing or Tailscale is stopped — never a throw", async () => {
  assert.equal(await tailnetStatus(async () => ({ code: null, stdout: "", stderr: "spawn ENOENT" })), null);
  assert.equal(
    await tailnetStatus(async () => ({
      code: 0,
      stdout: JSON.stringify({ BackendState: "Stopped" }),
      stderr: "",
    })),
    null,
  );
  assert.equal(
    (await tailnetStatus(async () => ({ code: 0, stdout: JSON.stringify(STATUS_FIXTURE), stderr: "" })))
      ?.dnsName,
    "coresoft-agent.tail3f0fb7.ts.net",
  );
});

// ---------------------------------------------------------------- tls

test("self-signed material: generated once with SANs, reused while valid, fingerprint is the SPKI hash", async () => {
  const tlsDir = path.join(dir, "tls");
  const c = clock(Date.now());
  const m1 = await selfSignedMaterial({ dir: tlsDir, hosts: ["pi-daemon.local", "127.0.0.1"], now: c.now });
  assert.equal(m1.mode, "self-signed");
  assert.match(m1.fingerprint, /^[0-9a-f]{64}$/);
  assert.ok(m1.hosts.includes("pi-daemon.local") && m1.hosts.includes("127.0.0.1"), JSON.stringify(m1.hosts));
  assert.equal(spkiFingerprint(m1.cert), m1.fingerprint);
  const m2 = await selfSignedMaterial({ dir: tlsDir, hosts: ["pi-daemon.local", "127.0.0.1"], now: c.now });
  assert.equal(m2.fingerprint, m1.fingerprint, "reused");
  const m3 = await selfSignedMaterial({
    dir: tlsDir,
    hosts: ["pi-daemon.local", "127.0.0.1", "10.0.0.9"],
    now: c.now,
  });
  assert.notEqual(m3.fingerprint, m1.fingerprint, "regenerated for a new host");
  if (platform !== "win32") assert.equal(statSync(path.join(tlsDir, "key.pem")).mode & 0o777, 0o600);
});

test("tailscale-cert material: runs `tailscale cert` and reports its failure verbatim", async () => {
  const tlsDir = path.join(dir, "ts-tls");
  const existing = await selfSignedMaterial({ dir: path.join(dir, "seed"), hosts: ["h.tailnet.ts.net"] });
  const calls: string[][] = [];
  const m = await tailscaleCertMaterial({
    dir: tlsDir,
    dnsName: "h.tailnet.ts.net",
    run: async (args) => {
      calls.push(args);
      const { writeFileSync } = await import("node:fs");
      writeFileSync(args[2] ?? "", existing.cert);
      writeFileSync(args[4] ?? "", existing.key);
      return { code: 0, stdout: "", stderr: "" };
    },
  });
  assert.equal(m.mode, "tailscale-cert");
  assert.equal(calls[0]?.[0], "cert");
  assert.equal(m.fingerprint, existing.fingerprint);
  await assert.rejects(
    tailscaleCertMaterial({
      dir: tlsDir,
      dnsName: "h",
      run: async () => ({
        code: 1,
        stdout: "",
        stderr: "HTTPS certificates are not enabled for this tailnet",
      }),
    }),
    /not enabled/,
  );
});

// ---------------------------------------------------------------- authenticate

function accessSetup(tailnet?: AccessControl["tailnet"]) {
  const c = clock();
  const devices = new DeviceStore(path.join(dir, `auth-${Math.random().toString(36).slice(2)}.json`), {
    now: c.now,
  });
  const tickets = new ConnectTickets({ now: c.now });
  const failures = new RateLimiter({ windowMs: 60_000, max: 3, now: c.now });
  const access: AccessControl = { devices, tickets, failures, tailnet };
  return { c, devices, tickets, failures, access };
}

test("authenticate: bearer, ticket only on upgrades, revoked token, failure lockout", () => {
  const { devices, tickets, access } = accessSetup();
  const owner = devices.create({ name: "phone", platform: "ios" });
  const ok = authenticate(fakeReq({ auth: `Bearer ${owner.token}` }), access);
  assert.ok(ok.ok && ok.principal.role === "owner");
  assert.equal(authenticate(fakeReq(), access).ok, false);

  const { ticket } = tickets.mint(owner.device.id, "127.0.0.1");
  assert.equal(
    authenticate(fakeReq({ url: `/pi/v1/socket?ticket=${ticket}` }), access).ok,
    false,
    "tickets are not accepted on plain requests",
  );
  const { ticket: t2 } = tickets.mint(owner.device.id, "127.0.0.1");
  const up = createUpgradeAuthenticator(access)(fakeReq({ url: `/pi/v1/socket?ticket=${t2}` })) as {
    ok: boolean;
    principal?: string;
  };
  assert.ok(up.ok && up.principal === owner.device.id);

  devices.revoke(owner.device.id);
  const revoked = authenticate(fakeReq({ auth: `Bearer ${owner.token}` }), access);
  assert.ok(!revoked.ok && revoked.status === 401);

  for (let i = 0; i < 3; i++)
    authenticate(
      fakeReq({ auth: `Bearer pid_BAD00000000000000_${"b".repeat(43)}`, remote: "9.9.9.9" }),
      access,
    );
  const locked = authenticate(
    fakeReq({ auth: `Bearer pid_BAD00000000000000_${"b".repeat(43)}`, remote: "9.9.9.9" }),
    access,
  );
  assert.ok(!locked.ok && locked.status === 429, JSON.stringify(locked));
  assert.equal(hasRole({ deviceId: "x", role: "member", name: "" }, "owner"), false);
  assert.equal(hasRole({ deviceId: "x", role: "owner", name: "" }, "member"), true);
});

test("authenticate: tailnet identity is recorded and an allowlist can refuse, but never admits without a token", () => {
  const status = parseStatus(STATUS_FIXTURE);
  const { devices, access } = accessSetup({ status: () => status, allowedUsers: ["azzlack@github"] });
  const d = devices.create({ name: "imac", platform: "macos" });
  const fromImac = authenticate(fakeReq({ auth: `Bearer ${d.token}`, remote: "100.107.75.77" }), access);
  assert.ok(fromImac.ok && fromImac.principal.tailnetUser === "azzlack@github");
  const fromVisitor = authenticate(fakeReq({ auth: `Bearer ${d.token}`, remote: "100.90.1.2" }), access);
  assert.ok(!fromVisitor.ok && fromVisitor.status === 403);
  const noToken = authenticate(fakeReq({ remote: "100.107.75.77" }), access);
  assert.ok(!noToken.ok && noToken.status === 401, "a tailnet address alone grants nothing");
});

// ---------------------------------------------------------------- http routes + revocation

async function startRoutes(t: TestContext) {
  const { c, devices, tickets, access } = accessSetup();
  const pairing = new PairingService({ devices, daemonId: "dm_TEST", now: c.now });
  const daemon = loadOrCreateIdentity(path.join(dir, `id-${Math.random().toString(36).slice(2)}.json`), {
    name: "test-daemon",
  });
  const revoked: string[] = [];
  const routes = createAccessRoutes({
    access,
    pairing,
    daemon,
    capabilities: () => ({ api: { version: 1 } }),
    onRevoked: (id) => revoked.push(id),
    now: c.now,
  });
  const server = http.createServer((req, res) => {
    void routes(req, res).then((handled) => {
      if (!handled) {
        res.statusCode = 404;
        res.end();
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  const port = (server.address() as net.AddressInfo).port;
  const call = async (method: string, p: string, body?: unknown, token?: string) => {
    const res = await fetch(`http://127.0.0.1:${port}${p}`, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    return { status: res.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : null };
  };
  return { c, devices, tickets, pairing, daemon, revoked, call };
}

test("routes: redeem a pairing code, mint a ticket, list and revoke devices with the owner role", async (t) => {
  const { pairing, daemon, revoked, call } = await startRoutes(t);
  assert.equal(
    (await call("POST", "/v1/pair/redeem", { code: "AAAA-AAAA", deviceName: "x", platform: "y" })).status,
    401,
  );
  const code = pairing.issue().code;
  const r1 = await call("POST", "/v1/pair/redeem", { code, deviceName: "phone", platform: "ios" });
  assert.equal(r1.status, 200);
  assert.equal(r1.body?.daemonId, daemon.id);
  assert.equal(r1.body?.role, "owner");
  const ownerToken = r1.body?.token as string;
  const ownerId = r1.body?.deviceId as string;
  assert.deepEqual(r1.body?.capabilities, { api: { version: 1 } });

  const code2 = pairing.issue().code;
  const r2 = await call("POST", "/v1/pair/redeem", { code: code2, deviceName: "laptop", platform: "macos" });
  const memberToken = r2.body?.token as string;
  const memberId = r2.body?.deviceId as string;
  assert.equal(r2.body?.role, "member");

  assert.equal((await call("POST", "/v1/connect-tickets")).status, 401);
  const tk = await call("POST", "/v1/connect-tickets", undefined, memberToken);
  assert.equal(tk.status, 201);
  assert.match(String(tk.body?.ticket), /^[A-Za-z0-9_-]{43}$/);

  assert.equal((await call("GET", "/v1/devices", undefined, memberToken)).status, 403);
  const list = await call("GET", "/v1/devices", undefined, ownerToken);
  assert.equal(list.status, 200);
  const devices = list.body?.devices as Array<Record<string, unknown>>;
  assert.equal(devices.length, 2);
  assert.ok(
    devices.every((d) => !("secretHash" in d)),
    "hashes never leave the store",
  );

  assert.equal(
    (await call("DELETE", `/v1/devices/${ownerId}`, undefined, ownerToken)).status,
    409,
    "the last owner cannot revoke itself",
  );
  assert.equal((await call("DELETE", `/v1/devices/${memberId}`, undefined, ownerToken)).status, 204);
  assert.deepEqual(revoked, [memberId]);
  assert.equal(
    (await call("POST", "/v1/connect-tickets", undefined, memberToken)).status,
    401,
    "revoked token is dead",
  );
  assert.equal((await call("DELETE", `/v1/devices/${memberId}`, undefined, ownerToken)).status, 404);
});

test("routes: pairing redemption is rate limited per peer", async (t) => {
  const { call } = await startRoutes(t);
  let last = 0;
  for (let i = 0; i < 6; i++)
    last = (await call("POST", "/v1/pair/redeem", { code: "AAAA-AAAA", deviceName: "x", platform: "y" }))
      .status;
  assert.equal(last, 429);
});

test("revoking a device closes its live protocol connections within the second", async (t) => {
  const FAKE = path.resolve(import.meta.dirname, "..", "..", "test", "fake-pi.mjs");
  const host = new SessionHost({
    launcher: { command: process.execPath, prefix: [FAKE], source: "env" },
    env: { PATH: process.env.PATH ?? "" },
    sweepIntervalMs: 0,
  });
  t.after(() => host.close());
  const server = new PiProtocolServer({ host, workspaces: singleRootResolver(dir), models: () => [] });
  t.after(() => server.closeAll());
  const { a, b } = memoryPair();
  let closedReason: string | undefined;
  a.onClose((r) => {
    closedReason = r;
  });
  server.attachTransport(b, { deviceId: "DEV_A" });
  const { a: a2, b: b2 } = memoryPair();
  let otherClosed = false;
  a2.onClose(() => {
    otherClosed = true;
  });
  server.attachTransport(b2, { deviceId: "DEV_B" });
  a.send(encodeClientMessage({ type: "hello", version: 1 }));
  a2.send(encodeClientMessage({ type: "hello", version: 1 }));
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(server.connectionCount, 2);
  assert.equal(server.closeForDevice("DEV_A"), 1);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(closedReason, "device revoked");
  assert.equal(otherClosed, false, "other devices are untouched");
  assert.equal(server.connectionCount, 1);
});
