// How Surface A's `cwd` becomes a workspace (spec §3, §4.3). pi-protocol puts `cwd` on the wire
// and we cannot change that, so an inbound cwd is an assertion to validate: canonicalise it and
// require it to resolve inside a registered workspace. `singleRootResolver` is the test stand-in.

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
  /** Surface B names workspaces by id only (spec §3). */
  workspaceById(workspaceId: string): { workspaceId: string; cwd: string } | undefined;
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
    workspaceById(id) {
      return id === workspaceId ? { workspaceId, cwd: canonicalRoot } : undefined;
    },
  };
}

/** The real thing (M6): every registered workspace root, deepest match wins. */
export function registryResolver(registry: {
  workspaces(): Array<{ id: string; path: string }>;
  workspace(id: string): { id: string; path: string } | undefined;
  workspaceForPath(canonical: string): { id: string; path: string } | undefined;
}): WorkspaceResolver {
  return {
    resolveCwd(requested) {
      if (requested === undefined || requested === "") {
        const first = registry.workspaces()[0];
        if (!first) return { ok: false, reason: "no workspace is registered" };
        return { ok: true, workspaceId: first.id, cwd: first.path };
      }
      if (!path.isAbsolute(requested)) return { ok: false, reason: "cwd must be absolute" };
      const candidate = canonicalize(requested);
      const ws = registry.workspaceForPath(candidate);
      if (!ws) return { ok: false, reason: "cwd is outside every registered workspace" };
      return { ok: true, workspaceId: ws.id, cwd: candidate };
    },
    workspaceFor(cwd) {
      const c = canonicalize(cwd);
      const ws = registry.workspaceForPath(c);
      return ws ? { workspaceId: ws.id, cwd: c } : undefined;
    },
    workspaceById(id) {
      const ws = registry.workspace(id);
      return ws ? { workspaceId: ws.id, cwd: ws.path } : undefined;
    },
  };
}
