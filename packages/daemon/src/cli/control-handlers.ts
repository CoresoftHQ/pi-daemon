// What the control endpoint answers (spec §8): status, stop, pairing, devices.

import type { Capabilities } from "@coresoft-hq/pi-daemon-contract";
import type { DaemonIdentity } from "../access/daemon-identity.ts";
import type { DeviceStore } from "../access/devices.ts";
import type { PairingService, RedeemRequest } from "../access/pairing.ts";
import type { TlsMaterial } from "../access/tls.ts";
import type { PiInstall } from "../runners/version.ts";
import type { PiProtocolServer } from "../serve/pi-protocol/server.ts";
import type { EventLog } from "../sessions/events.ts";
import type { SessionHost } from "../sessions/host.ts";
import type { TerminalManager } from "../terminals/manager.ts";
import type { WorkspaceRegistry } from "../workspaces/registry.ts";
import type { ControlHandler } from "./control.ts";

export type ConfirmHook = (request: RedeemRequest) => Promise<boolean>;

export interface ControlContext {
  version: string;
  identity: DaemonIdentity;
  address: string;
  port: number;
  advertisedHost: string;
  localEndpoint: string;
  controlEndpoint: () => string;
  tls: TlsMaterial | null;
  startedAt: number;
  pi: PiInstall;
  host: SessionHost;
  terminals: TerminalManager;
  registry: WorkspaceRegistry;
  devices: DeviceStore;
  pairing: PairingService;
  events: EventLog;
  protocol: PiProtocolServer;
  capabilities: () => Capabilities;
  stop: () => void;
  /** `pair --confirm` installs a y/N hook for the duration of one code. */
  confirm: { current: ConfirmHook | null };
  now: () => number;
}

export function controlHandlers(c: ControlContext): Record<string, ControlHandler> {
  return {
    ping: async () => ({ pid: process.pid, port: c.port }),
    capabilities: async () => c.capabilities(),
    status: async () => ({
      pid: process.pid,
      version: c.version,
      daemonId: c.identity.id,
      name: c.identity.name,
      address: c.address,
      port: c.port,
      advertisedHost: c.advertisedHost,
      localEndpoint: c.localEndpoint,
      controlEndpoint: c.controlEndpoint(),
      tls: c.tls?.mode ?? "off",
      fingerprint: c.tls?.fingerprint ?? null,
      startedAt: c.startedAt,
      pi: c.pi,
      sessions: c.host.list().filter((s) => s.live).length,
      terminals: c.terminals.list().filter((t) => t.status === "running").length,
      workspaces: c.registry.workspaces().length,
      devices: c.devices.list().length,
      capabilities: c.capabilities(),
    }),
    stop: async (_params, ctx) => {
      ctx.emit("stopping");
      setTimeout(c.stop, 10);
      return { stopping: true };
    },
    "pair.issue": async (params, ctx) => {
      const code = c.pairing.issue();
      const payload = c.pairing.payload({
        host: c.advertisedHost,
        port: c.port,
        fingerprint: c.tls?.fingerprint,
      });
      if (params.confirm !== true) return { code: code.code, expiresAt: code.expiresAt, payload };
      // Stay on the line: the daemon asks this CLI y/N at redemption and reports the outcome.
      const hook: ConfirmHook = async (request) =>
        (await ctx.ask("confirm", { deviceName: request.deviceName, platform: request.platform })) === true;
      c.confirm.current = hook;
      const redeemed = await new Promise<unknown>((resolve) => {
        const off = c.events.subscribe((e) => {
          if (e.type === "device.paired") {
            off();
            resolve(e.payload);
          }
        });
        setTimeout(
          () => {
            off();
            resolve(null);
          },
          Math.max(1000, code.expiresAt - c.now() + 500),
        );
      });
      if (c.confirm.current === hook) c.confirm.current = null;
      return { code: code.code, expiresAt: code.expiresAt, payload, redeemed };
    },
    "pair.active": async () => c.pairing.active(),
    "devices.list": async () => c.devices.list(),
    "devices.revoke": async (params) => {
      const id = String(params.id ?? "");
      const revoked = c.devices.revoke(id);
      if (revoked) {
        c.protocol.closeForDevice(id);
        c.events.append("daemon", "device.revoked", { deviceId: id });
      }
      return { revoked };
    },
    "devices.create": async (params) => {
      const created = c.devices.create({
        name: String(params.name ?? "service"),
        platform: String(params.platform ?? "service"),
        role: params.role === "owner" ? "owner" : "member",
      });
      return { device: created.device, token: created.token };
    },
  };
}
