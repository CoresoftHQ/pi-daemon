// The device store (spec §6.1, §6.3): one record per paired device, secret hashed at rest,
// written atomically with owner-only permissions. The first device is the owner.

import { mkdirSync } from "node:fs";
import path from "node:path";
import { readJsonSync, writeJsonAtomicSync } from "../os/fsx.ts";
import { hashSecret, mintToken, parseToken, verifySecret } from "./tokens.ts";

export type Role = "owner" | "member";

export interface DeviceRecord {
  id: string;
  name: string;
  platform: string;
  role: Role;
  createdAt: number;
  lastSeenAt?: number;
  /** The tailnet login this device was last seen from, for display (spec §6.5). */
  tailnetUser?: string;
  secretHash: string;
}

/** What routes may show: never the hash. */
export type DeviceView = Omit<DeviceRecord, "secretHash">;

interface StoreFile {
  version: 1;
  devices: DeviceRecord[];
}

export interface DeviceStoreOptions {
  now?: (() => number) | undefined;
}

export class DeviceStore {
  readonly file: string;
  readonly #now: () => number;
  #devices = new Map<string, DeviceRecord>();

  constructor(file: string, options: DeviceStoreOptions = {}) {
    this.file = file;
    this.#now = options.now ?? Date.now;
    this.#load();
  }

  #load(): void {
    const data = readJsonSync<StoreFile>(this.file);
    this.#devices = new Map((data?.devices ?? []).map((d) => [d.id, d]));
  }

  #save(): void {
    mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const out: StoreFile = { version: 1, devices: [...this.#devices.values()] };
    writeJsonAtomicSync(this.file, out, { mode: 0o600 });
  }

  static view(d: DeviceRecord): DeviceView {
    const { secretHash: _hash, ...rest } = d;
    return rest;
  }

  get count(): number {
    return this.#devices.size;
  }

  list(): DeviceView[] {
    return [...this.#devices.values()].map(DeviceStore.view);
  }

  get(id: string): DeviceRecord | undefined {
    return this.#devices.get(id);
  }

  /** Pair a new device. Returns the token exactly once; it is never stored. */
  create(params: { name: string; platform: string; role?: Role | undefined }): {
    device: DeviceView;
    token: string;
  } {
    const minted = mintToken();
    const role: Role = params.role ?? (this.#devices.size === 0 ? "owner" : "member");
    const device: DeviceRecord = {
      id: minted.deviceId,
      name: params.name.slice(0, 80),
      platform: params.platform.slice(0, 40),
      role,
      createdAt: this.#now(),
      secretHash: minted.secretHash,
    };
    this.#devices.set(device.id, device);
    this.#save();
    return { device: DeviceStore.view(device), token: minted.token };
  }

  /** Verify a presented token. Touches lastSeenAt on success. */
  verify(token: string): DeviceRecord | null {
    const parsed = parseToken(token);
    if (!parsed) return null;
    const device = this.#devices.get(parsed.deviceId);
    if (!device) {
      // Burn the same time as a real comparison so a missing id is not distinguishable by timing.
      verifySecret(parsed.secret, hashSecret("nope"));
      return null;
    }
    if (!verifySecret(parsed.secret, device.secretHash)) return null;
    device.lastSeenAt = this.#now();
    return device;
  }

  /** Record where a device was last seen from. */
  touch(id: string, fields: { tailnetUser?: string | undefined }): void {
    const d = this.#devices.get(id);
    if (!d) return;
    d.lastSeenAt = this.#now();
    if (fields.tailnetUser !== undefined && fields.tailnetUser !== d.tailnetUser) {
      d.tailnetUser = fields.tailnetUser;
      this.#save();
    }
  }

  /** Persist lastSeen changes (batched by the caller, since they are frequent). */
  flush(): void {
    this.#save();
  }

  revoke(id: string): boolean {
    const removed = this.#devices.delete(id);
    if (removed) this.#save();
    return removed;
  }

  setRole(id: string, role: Role): boolean {
    const d = this.#devices.get(id);
    if (!d) return false;
    d.role = role;
    this.#save();
    return true;
  }

  /** Rename, for a client that paired with a placeholder. */
  rename(id: string, name: string): boolean {
    const d = this.#devices.get(id);
    if (!d) return false;
    d.name = name.slice(0, 80);
    this.#save();
    return true;
  }
}
