// Enumerate pi's sessions without spawning anything (spec §2.2): read only file names and each
// file's header line under the session directory. Never the transcript.

import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import path from "node:path";

export interface SessionHeader {
  id: string;
  file: string;
  cwd?: string;
  name?: string;
  createdAt: number;
  updatedAt: number;
  sizeBytes: number;
}

const HEADER_BYTES = 4096;

function readFirstLine(file: string): string {
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(HEADER_BYTES);
    const n = readSync(fd, buf, 0, HEADER_BYTES, 0);
    const text = buf.subarray(0, n).toString("utf8");
    const nl = text.indexOf("\n");
    return nl === -1 ? text : text.slice(0, nl);
  } finally {
    closeSync(fd);
  }
}

/** Walk the session directory (pi keys subdirectories by working directory) and read headers. */
export function readSessionHeaders(sessionsDir: string): SessionHeader[] {
  const out: SessionHeader[] = [];
  const walk = (dir: string) => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.endsWith(".jsonl")) {
        try {
          const header = JSON.parse(readFirstLine(p)) as Record<string, unknown>;
          if (header.type !== "session" || typeof header.id !== "string") continue;
          const st = statSync(p);
          const createdAt =
            typeof header.timestamp === "string" ? Date.parse(header.timestamp) : st.birthtimeMs;
          out.push({
            id: header.id,
            file: p,
            ...(typeof header.cwd === "string" ? { cwd: header.cwd } : {}),
            ...(typeof header.name === "string" ? { name: header.name } : {}),
            createdAt: Number.isFinite(createdAt) ? createdAt : st.mtimeMs,
            updatedAt: st.mtimeMs,
            sizeBytes: st.size,
          });
        } catch {
          /* not a session file, or truncated header; skip */
        }
      }
    }
  };
  walk(sessionsDir);
  return out;
}
