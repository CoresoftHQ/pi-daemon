// The daemon's own identity (spec §3): a ULID-like id minted once at first start and persisted,
// plus a human name, so a client that has paired with several machines can tell them apart.

import { mkdirSync } from "node:fs";
import path from "node:path";
import { readJsonSync, writeJsonAtomicSync } from "../os/fsx.ts";
import { crockfordId } from "./tokens.ts";

export interface DaemonIdentity {
  id: string;
  name: string;
  createdAt: number;
}

export function loadOrCreateIdentity(
  file: string,
  defaults: { name: string; now?: (() => number) | undefined },
): DaemonIdentity {
  const existing = readJsonSync<DaemonIdentity>(file);
  if (existing && typeof existing.id === "string" && typeof existing.name === "string") return existing;
  const identity: DaemonIdentity = {
    id: `dm_${crockfordId(10)}`,
    name: defaults.name,
    createdAt: (defaults.now ?? Date.now)(),
  };
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeJsonAtomicSync(file, identity, { mode: 0o600 });
  return identity;
}
