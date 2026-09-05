// The capability document (spec §10): how a client learns what it is talking to.

import type { Capabilities } from "@coresoft-hq/pi-daemon-contract";
import type { DaemonIdentity } from "../../access/daemon-identity.ts";

export interface CapabilitiesInput {
  identity: DaemonIdentity;
  version: string;
  platform: string;
  startedAt: number;
  pi: { version: string | null; supported: string; path: string | null };
  maxFrameLength: number;
  features: string[];
  absent: string[];
  limits: Record<string, number>;
}

export function buildCapabilities(input: CapabilitiesInput): Capabilities {
  return {
    daemon: {
      id: input.identity.id,
      name: input.identity.name,
      version: input.version,
      platform: input.platform,
      startedAt: input.startedAt,
    },
    api: { version: 1 },
    piProtocol: { version: 1, maxFrameLength: input.maxFrameLength },
    pi: input.pi,
    features: input.features,
    absent: input.absent,
    limits: input.limits,
  };
}

/** The pi versions this daemon has been tested against (spec §10). */
export const SUPPORTED_PI_RANGE = ">=0.84.0 <0.86.0";
