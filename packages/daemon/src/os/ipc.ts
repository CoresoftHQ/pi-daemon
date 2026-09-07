// The local endpoint: a Unix domain socket under the state directory, or a Windows named pipe.
// Both are reachable through net.connect(path), which is the seam pi-client's Unix transport
// already uses (spec §4.1, §9) — verified by ipc.test.ts rather than assumed.

import { createHash } from "node:crypto";
import { chmodSync, unlinkSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { platform, tmpDir, userName } from "./paths.ts";

/** macOS limits sun_path to 104 bytes; Linux to 108. Stay under the smaller. */
const SUN_PATH_LIMIT = 100;

export function localEndpointPath(stateDir: string, name = "pi-daemon"): string {
  if (platform === "win32") {
    // Pipes have no directory, so the state directory goes into the name: two daemons with
    // different homes (PI_DAEMON_HOME, tests) must not share an endpoint.
    const user = userName().replace(/[^A-Za-z0-9_-]/g, "_");
    const home = createHash("sha256").update(path.resolve(stateDir).toLowerCase()).digest("hex").slice(0, 8);
    return `\\\\.\\pipe\\${name}-${user}-${home}`;
  }
  const preferred = path.join(stateDir, `${name}.sock`);
  if (Buffer.byteLength(preferred) < SUN_PATH_LIMIT) return preferred;
  return path.join(tmpDir(), `${name}-${userName()}.sock`);
}

function probe(endpoint: string): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect(endpoint);
    s.once("connect", () => {
      s.destroy();
      resolve(true);
    });
    s.once("error", () => resolve(false));
  });
}

/**
 * Listen on the local endpoint. On POSIX a socket file left by a dead daemon must be removed
 * first, but only after confirming nobody answers on it.
 */
export async function listenLocal(server: net.Server, endpoint: string): Promise<void> {
  if (platform !== "win32") {
    if (await probe(endpoint)) throw new Error(`something is already listening on ${endpoint}`);
    try {
      unlinkSync(endpoint);
    } catch {
      /* no stale socket */
    }
  }
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(endpoint, () => {
      server.off("error", reject);
      // Filesystem permissions are the authentication on the local endpoints (spec §6, §9).
      if (platform !== "win32") {
        try {
          chmodSync(endpoint, 0o600);
        } catch {
          /* best effort; the parent directory is already 0700 */
        }
      }
      resolve();
    });
  });
}

export function connectLocal(endpoint: string): net.Socket {
  return net.connect(endpoint);
}
