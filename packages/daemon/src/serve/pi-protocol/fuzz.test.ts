// Fuzzing the framed-CBOR path (plan M9): the only attacker-reachable parser. Every mutation
// the plan lists — truncation, coalescing, oversized declared lengths, deep nesting, malformed
// UTF-8, unknown properties — plus random bytes, against the real server over the in-memory
// transport. The property: the server never throws, the offending connection ends, and a
// well-behaved client attached afterwards is served normally.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import type { ByteTransportFactory } from "@earendil-works/pi-client";
import { PiClient } from "@earendil-works/pi-client";
import { encodeCbor, encodeClientMessage, encodeFrame } from "@earendil-works/pi-protocol";
import { tmpDir } from "../../os/paths.ts";
import { SessionHost } from "../../sessions/host.ts";
import { memoryPair } from "../transport.ts";
import { singleRootResolver } from "../workspace-resolver.ts";
import { PiProtocolServer } from "./server.ts";

const FAKE = path.resolve(import.meta.dirname, "..", "..", "..", "test", "fake-pi.mjs");
const launcher = { command: process.execPath, prefix: [FAKE], source: "env" as const };
const ITERATIONS = Number(process.env.PI_DAEMON_FUZZ_ITERATIONS ?? 40);
const MAX_FRAME = 64 * 1024;

let root: string;
let host: SessionHost;
let server: PiProtocolServer;
const uncaught: unknown[] = [];
const onUncaught = (e: unknown) => uncaught.push(e);

before(() => {
  root = mkdtempSync(path.join(tmpDir(), "pi-daemon-fuzz-"));
  host = new SessionHost({ launcher, env: { PATH: process.env.PATH ?? "" }, sweepIntervalMs: 0 });
  server = new PiProtocolServer({
    host,
    workspaces: singleRootResolver(root),
    models: () => [],
    maxFrameLength: MAX_FRAME,
  });
  process.on("uncaughtException", onUncaught);
  process.on("unhandledRejection", onUncaught);
});
after(async () => {
  process.off("uncaughtException", onUncaught);
  process.off("unhandledRejection", onUncaught);
  server.closeAll();
  await host.close();
  rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  const next = () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0x1_0000_0000;
  };
  return { next, int: (n: number) => Math.floor(next() * n) };
}

const HELLO = encodeClientMessage({ type: "hello", version: 1 } as never);
const LIST = encodeClientMessage({ type: "request", id: "r1", request: { command: "list" } } as never);

/** One attack: bytes on the wire, and whether a close is required (some mutations are legal). */
type Attack = { name: string; bytes: Uint8Array[] };

function attacks(r: ReturnType<typeof rng>): Attack[] {
  const cat = (...parts: Uint8Array[]) => Buffer.concat(parts.map((p) => Buffer.from(p)));
  const framed = (payload: Uint8Array) => encodeFrame(payload);
  const deep = (n: number) => {
    // n nested single-element arrays around a hello-shaped map: [[[[{...}]]]]
    const inner = encodeCbor({ type: "hello", version: 1 });
    let out = Buffer.from(inner);
    for (let i = 0; i < n; i++) out = Buffer.concat([Buffer.from([0x81]), out]);
    return new Uint8Array(out);
  };
  const badUtf8 = () => {
    // a map {"type": <text with invalid bytes>}: a1 64 "type" 63 ff fe fd
    return new Uint8Array([0xa1, 0x64, 0x74, 0x79, 0x70, 0x65, 0x63, 0xff, 0xfe, 0xfd]);
  };
  const random = (n: number) => {
    const b = new Uint8Array(n);
    for (let i = 0; i < n; i++) b[i] = r.int(256);
    return b;
  };
  const oversized = () => {
    const header = Buffer.alloc(4);
    header.writeUInt32BE(MAX_FRAME * 4);
    return new Uint8Array(cat(header, random(64)));
  };
  const huge = () => {
    const header = Buffer.alloc(4);
    header.writeUInt32BE(0xffff_ffff);
    return new Uint8Array(cat(header, random(8)));
  };
  const cut = HELLO.subarray(0, 1 + r.int(HELLO.length - 1));
  return [
    { name: "truncated hello then silence", bytes: [cut] },
    { name: "two frames coalesced then a truncated third", bytes: [cat(HELLO, LIST, cut)] },
    { name: "hello split one byte at a time", bytes: Array.from(HELLO, (b) => new Uint8Array([b])) },
    { name: "oversized declared length", bytes: [oversized()] },
    { name: "4 GiB declared length", bytes: [huge()] },
    { name: "deep nesting 200", bytes: [framed(deep(200))] },
    { name: "deep nesting 5000", bytes: [framed(deep(5000))] },
    { name: "malformed UTF-8 in a text string", bytes: [framed(badUtf8())] },
    {
      name: "unknown property on hello",
      bytes: [framed(encodeCbor({ type: "hello", version: 1, extra: "nope" }))],
    },
    {
      name: "unknown property on a request",
      bytes: [
        HELLO,
        framed(encodeCbor({ type: "request", id: "r2", bogus: 1, request: { command: "list" } })),
      ],
    },
    { name: "wrong top-level type", bytes: [framed(encodeCbor([1, 2, 3]))] },
    { name: "empty frame", bytes: [framed(new Uint8Array(0))] },
    { name: "zero-length header only", bytes: [new Uint8Array([0, 0, 0, 0])] },
    { name: "request before hello", bytes: [LIST] },
    { name: "random bytes", bytes: [random(1 + r.int(4096))] },
    { name: "random after a good hello", bytes: [HELLO, random(1 + r.int(2048))] },
    {
      name: "valid frame with trailing garbage inside the payload",
      bytes: [framed(cat(encodeCbor({ type: "hello", version: 1 }), random(16)))],
    },
  ];
}

async function fire(attack: Attack): Promise<{ closed: boolean }> {
  const { a, b } = memoryPair(attack.name);
  let serverClosed = false;
  let selfClosed = false;
  const closed = new Promise<void>((resolve) =>
    a.onClose(() => {
      if (!selfClosed) serverClosed = true;
      resolve();
    }),
  );
  a.onData(() => undefined);
  server.attachTransport(b);
  for (const chunk of attack.bytes) a.send(chunk);
  // a legal-but-partial stream stays open, which is fine; give the server a moment to decide
  await Promise.race([closed, new Promise((r) => setTimeout(r, 60))]);
  if (!serverClosed) {
    selfClosed = true;
    a.close("fuzz done");
    await new Promise((r) => setTimeout(r, 1));
  }
  return { closed: serverClosed };
}

test(`${ITERATIONS} rounds of hostile bytes never throw, and a good client is served afterwards`, async (t) => {
  const outcomes = new Map<string, { closed: number; open: number }>();
  for (let iteration = 0; iteration < ITERATIONS; iteration++) {
    const r = rng(9000 + iteration);
    for (const attack of attacks(r)) {
      const { closed } = await fire(attack);
      const o = outcomes.get(attack.name) ?? { closed: 0, open: 0 };
      if (closed) o.closed += 1;
      else o.open += 1;
      outcomes.set(attack.name, o);
    }
  }
  assert.deepEqual(uncaught, [], "nothing escaped the server");
  // the ones that must close: anything that is provably not a frame or not a message
  for (const name of [
    "oversized declared length",
    "4 GiB declared length",
    "malformed UTF-8 in a text string",
    "unknown property on hello",
    "wrong top-level type",
    "empty frame",
    "request before hello",
  ]) {
    const o = outcomes.get(name);
    assert.ok(
      o && o.open === 0,
      `${name}: expected the server to close every time, got ${JSON.stringify(o)}`,
    );
  }
  t.diagnostic(`outcomes: ${JSON.stringify([...outcomes])}`);

  // a well-behaved client afterwards
  const factory: ByteTransportFactory = async (handlers) => {
    const { a, b } = memoryPair("good");
    server.attachTransport(b);
    a.onData((c) => handlers.onData(c));
    a.onClose(() => handlers.onClose());
    return { send: async (chunk) => a.send(chunk), close: () => a.close() };
  };
  const client = new PiClient({ transportFactory: factory, maxFrameLength: MAX_FRAME });
  t.after(() => client.dispose().catch(() => {}));
  await client.connect();
  const sessions = await client.listSessions();
  assert.ok(Array.isArray(sessions));
});
