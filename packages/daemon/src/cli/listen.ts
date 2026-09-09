// Where to listen and how (spec §6.5): bind address, the name pairing advertises, and TLS.

import path from "node:path";
import type { TailscaleExec } from "../access/tailscale.ts";
import { runTailscale, TailnetStatusCache } from "../access/tailscale.ts";
import type { TlsMaterial } from "../access/tls.ts";
import { selfSignedMaterial, tailscaleCertMaterial } from "../access/tls.ts";
import type { Logger } from "../os/log.ts";
import type { AppDirs } from "../os/paths.ts";
import { hostName, platform } from "../os/paths.ts";
import type { DaemonConfig } from "./config.ts";

export class BindError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BindError";
  }
}

export interface Listen {
  address: string;
  advertisedHost: string;
  tls: TlsMaterial | null;
  tailnet: TailnetStatusCache;
}

export async function resolveListen(options: {
  config: DaemonConfig;
  dirs: AppDirs;
  log: Logger;
  tailscale?: TailscaleExec | undefined;
  now?: (() => number) | undefined;
}): Promise<Listen> {
  const { config, dirs, log } = options;
  const tailscale = options.tailscale ?? runTailscale;
  const tailnet = new TailnetStatusCache({ run: tailscale, now: options.now });
  const tailnetNow = () => tailnet.refresh().catch(() => null);

  let address: string;
  let advertisedHost: string;
  if (config.bind === "loopback") {
    address = "127.0.0.1";
    advertisedHost = "127.0.0.1";
  } else if (config.bind === "tailscale") {
    const ts = await tailnetNow();
    if (!ts?.running || ts.ips.length === 0)
      throw new BindError("bind is tailscale but Tailscale is not running; `pi-daemon doctor` has details");
    address = ts.ips[0] ?? "";
    advertisedHost = ts.dnsName ?? address;
  } else {
    address = config.bind;
    advertisedHost = config.bind === "0.0.0.0" || config.bind === "::" ? hostName() : config.bind;
    if (platform === "win32")
      log.warn("first non-loopback bind on Windows raises a firewall prompt", { address });
  }

  const tlsMode =
    config.tls !== "auto"
      ? config.tls
      : config.bind === "loopback"
        ? "off"
        : config.bind === "tailscale"
          ? "tailscale-cert"
          : "self-signed";
  let tls: TlsMaterial | null = null;
  if (tlsMode === "self-signed") {
    tls = await selfSignedMaterial({
      dir: path.join(dirs.state, "tls"),
      hosts: [...new Set([hostName(), advertisedHost, address, "localhost", "127.0.0.1"].filter(Boolean))],
    });
  } else if (tlsMode === "tailscale-cert") {
    const ts = await tailnetNow();
    if (!ts?.dnsName)
      throw new BindError(
        "tls is tailscale-cert but this machine has no MagicDNS name; is Tailscale running with MagicDNS on?",
      );
    tls = await tailscaleCertMaterial({
      dir: path.join(dirs.state, "tls"),
      dnsName: ts.dnsName,
      run: (args) => tailscale(args),
    });
    advertisedHost = ts.dnsName;
  }
  return { address, advertisedHost, tls, tailnet };
}
