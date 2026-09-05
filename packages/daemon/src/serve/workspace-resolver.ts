// How Surface A's `cwd` becomes a workspace (spec §3, §4.3). pi-protocol puts `cwd` on the wire
// and we cannot change that, so an inbound cwd is an assertion to validate: canonicalise it and
// require it to resolve inside a registered workspace. Until M6 builds the registry, a single
// allowed root stands in.

import path from "node:path";
import { canonicalize, isInside } from "../os/canon.ts";

export type ResolvedWorkspace =
  | { ok: true; workspaceId: string; cwd: string }
  | { ok: false; reason: string };

export interface WorkspaceResolver {
  /** Resolve an optional client-supplied cwd. Omitted means "the default workspace". */
  resolveCwd(requested?: string): ResolvedWorkspace;
  /** The workspace a known session lives in, by its recorded cwd. */
  workspaceFor(cwd: string): { workspaceId: string; cwd: string } | undefined;
}

export function singleRootResolver(root: string, workspaceId = "default"): WorkspaceResolver {
  const canonicalRoot = canonicalize(root);
  return {
    resolveCwd(requested) {
      if (requested === undefined || requested === "") return { ok: true, workspaceId, cwd: canonicalRoot };
      const candidate = canonicalize(path.resolve(canonicalRoot, requested));
      if (!isInside(canonicalRoot, candidate))
        return { ok: false, reason: "cwd is outside every registered workspace" };
      return { ok: true, workspaceId, cwd: candidate };
    },
    workspaceFor(cwd) {
      const c = canonicalize(cwd);
      return isInside(canonicalRoot, c) ? { workspaceId, cwd: c } : undefined;
    },
  };
}
