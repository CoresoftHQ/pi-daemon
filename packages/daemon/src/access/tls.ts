// TLS material (spec §6.5). Three modes: `off` for loopback only; `tailscale-cert`, a publicly
// trusted certificate for <host>.<tailnet>.ts.net from `tailscale cert` — the only clean answer
// for a browser client; and `self-signed`, pinned through the QR fingerprint, fine for native
// clients and painful for browsers. The fingerprint is sha256 over the certificate's SPKI.

import { createHash, X509Certificate } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { writeFileAtomicSync } from "../os/fsx.ts";
import type { ExecResult } from "../os/service/exec.ts";
import { exec } from "../os/service/exec.ts";

export type TlsMode = "off" | "self-signed" | "tailscale-cert";

export interface TlsMaterial {
  mode: Exclude<TlsMode, "off">;
  cert: string;
  key: string;
  /** sha256 of the SPKI, hex lowercase. What the QR payload carries as `fp`. */
  fingerprint: string;
  /** Names and addresses the certificate is valid for. */
  hosts: string[];
  notAfter: number;
}

export function spkiFingerprint(certPem: string): string {
  const cert = new X509Certificate(certPem);
  const spki = cert.publicKey.export({ type: "spki", format: "der" });
  return createHash("sha256").update(spki).digest("hex");
}

function describe(certPem: string, mode: TlsMaterial["mode"], keyPem: string): TlsMaterial {
  const cert = new X509Certificate(certPem);
  const hosts = (cert.subjectAltName ?? "")
    .split(",")
    .map((s) => s.trim().replace(/^(DNS|IP Address):/, ""))
    .filter(Boolean);
  return {
    mode,
    cert: certPem,
    key: keyPem,
    fingerprint: spkiFingerprint(certPem),
    hosts,
    notAfter: Date.parse(cert.validTo),
  };
}

export interface SelfSignedOptions {
  /** Where cert.pem and key.pem live. */
  dir: string;
  /** DNS names and IP addresses to put in the SAN. */
  hosts: string[];
  days?: number | undefined;
  now?: (() => number) | undefined;
  /** Regenerate when fewer than this many days remain. */
  renewBeforeDays?: number | undefined;
}

const isIp = (h: string) => /^(\d{1,3}\.){3}\d{1,3}$/.test(h) || h.includes(":");

/** Load an existing self-signed pair if it is still valid for these hosts; otherwise generate. */
export async function selfSignedMaterial(options: SelfSignedOptions): Promise<TlsMaterial> {
  const now = options.now ?? Date.now;
  const certFile = path.join(options.dir, "cert.pem");
  const keyFile = path.join(options.dir, "key.pem");
  const renewMs = (options.renewBeforeDays ?? 30) * 86_400_000;
  if (existsSync(certFile) && existsSync(keyFile)) {
    try {
      const existing = describe(readFileSync(certFile, "utf8"), "self-signed", readFileSync(keyFile, "utf8"));
      const covers = options.hosts.every((h) => existing.hosts.includes(h));
      if (covers && existing.notAfter - now() > renewMs) return existing;
    } catch {
      /* unreadable or corrupt: regenerate */
    }
  }
  const { generate } = await import("selfsigned");
  const altNames = options.hosts.map((h) =>
    isIp(h) ? { type: 7 as const, ip: h } : { type: 2 as const, value: h },
  );
  const result = await generate([{ name: "commonName", value: options.hosts[0] ?? "pi-daemon" }], {
    notBeforeDate: new Date(now() - 5 * 60_000),
    notAfterDate: new Date(now() + (options.days ?? 825) * 86_400_000),
    keyType: "rsa",
    keySize: 2048,
    algorithm: "sha256",
    extensions: [
      { name: "basicConstraints", cA: false },
      { name: "keyUsage", digitalSignature: true, keyEncipherment: true },
      { name: "extKeyUsage", serverAuth: true },
      { name: "subjectAltName", altNames },
    ],
  });
  mkdirSync(options.dir, { recursive: true, mode: 0o700 });
  writeFileAtomicSync(keyFile, result.private, { mode: 0o600 });
  writeFileAtomicSync(certFile, result.cert, { mode: 0o644 });
  return describe(result.cert, "self-signed", result.private);
}

export type TailscaleCertExec = (args: string[]) => Promise<ExecResult>;

/**
 * `tailscale cert <dnsName>` writes a Let's Encrypt certificate for the machine's MagicDNS
 * name. Requires HTTPS certificates enabled on the tailnet; the error says so when not.
 */
export async function tailscaleCertMaterial(options: {
  dir: string;
  dnsName: string;
  run?: TailscaleCertExec | undefined;
}): Promise<TlsMaterial> {
  const run = options.run ?? ((args) => exec("tailscale", args));
  mkdirSync(options.dir, { recursive: true, mode: 0o700 });
  const certFile = path.join(options.dir, `${options.dnsName}.crt`);
  const keyFile = path.join(options.dir, `${options.dnsName}.key`);
  const r = await run(["cert", "--cert-file", certFile, "--key-file", keyFile, options.dnsName]);
  if (r.code !== 0)
    throw new Error(`tailscale cert failed: ${(r.stderr || r.stdout).trim() || `exit ${r.code}`}`);
  return describe(readFileSync(certFile, "utf8"), "tailscale-cert", readFileSync(keyFile, "utf8"));
}
