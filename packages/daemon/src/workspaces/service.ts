// The workspace service: the registry plus everything that moves — watchers, the git-status
// cache they invalidate, and the registry/file events the daemon publishes (spec §3.1, §5.4).
// Publishes through a callback so this module never knows the event log.

import type { Logger } from "../os/log.ts";
import type { StatusSummary } from "./git.ts";
import { gitAvailable, status } from "./git.ts";
import type { Group, Project, Workspace, WorkspaceRegistry } from "./registry.ts";
import { WorkspaceWatchers } from "./watch.ts";

export type WorkspaceScope = `workspace:${string}` | "daemon";
export type Publish = (scope: WorkspaceScope, type: string, payload: unknown) => void;

export interface WorkspaceStatusResult extends StatusSummary {
  dirty: boolean;
  at: number;
}

export interface WorkspaceServiceOptions {
  registry: WorkspaceRegistry;
  publish: Publish;
  /** The operator's `files.write` switch (spec §5.4). */
  filesWrite?: boolean | undefined;
  statusTtlMs?: number | undefined;
  debounceMs?: number | undefined;
  now?: (() => number) | undefined;
  log?: Logger | undefined;
}

export class WorkspaceService {
  readonly registry: WorkspaceRegistry;
  /** The operator's switch; flipped at runtime by `pi-daemon config` (M8). */
  filesWrite: boolean;
  readonly #publish: Publish;
  readonly #now: () => number;
  readonly #ttl: number;
  readonly #watchers: WorkspaceWatchers;
  readonly #status = new Map<string, { at: number; value: Promise<WorkspaceStatusResult> }>();
  readonly #log: Logger | undefined;

  constructor(options: WorkspaceServiceOptions) {
    this.registry = options.registry;
    this.filesWrite = options.filesWrite ?? true;
    this.#publish = options.publish;
    this.#now = options.now ?? Date.now;
    this.#ttl = options.statusTtlMs ?? 5000;
    this.#log = options.log;
    this.#watchers = new WorkspaceWatchers({
      debounceMs: options.debounceMs,
      log: options.log,
      onChange: (change) => {
        this.#status.delete(change.workspaceId);
        if (change.paths.length === 0 && !change.truncated) return;
        this.#publish(`workspace:${change.workspaceId}`, "workspace.files_changed", {
          workspaceId: change.workspaceId,
          paths: change.paths,
          truncated: change.truncated,
          origin: "external",
        });
      },
    });
  }

  /** Watch everything already registered. */
  start(): void {
    for (const w of this.registry.workspaces()) this.#watchers.watch(w.id, w.path);
  }

  close(): void {
    this.#watchers.close();
  }

  watchMode(workspaceId: string): "native" | "poll" | undefined {
    return this.#watchers.mode(workspaceId);
  }

  /** A listing happened here; the watcher may want to know (Linux polling fallback). */
  listed(workspaceId: string, relDir: string): void {
    this.#watchers.touch(workspaceId, relDir);
  }

  // ---- registry operations that also watch and publish

  async register(
    dir: string,
    options: { name?: string | undefined; groupIds?: string[] | undefined } = {},
  ): Promise<{ project?: Project | undefined; workspaces: Workspace[] }> {
    const result = await this.registry.register(dir, options);
    if (result.project)
      this.#publish("daemon", "project.changed", {
        projectId: result.project.id,
        change: "registered",
        project: publicProject(result.project),
      });
    for (const w of result.workspaces) {
      this.#watchers.watch(w.id, w.path);
      this.#publish("daemon", "workspace.changed", {
        workspaceId: w.id,
        change: "registered",
        workspace: publicWorkspace(w),
      });
    }
    return result;
  }

  deregister(workspaceId: string): boolean {
    const w = this.registry.workspace(workspaceId);
    if (!w) return false;
    const projectId = w.projectId;
    if (!this.registry.deregister(workspaceId)) return false;
    this.#watchers.unwatch(workspaceId);
    this.#status.delete(workspaceId);
    this.#publish("daemon", "workspace.changed", { workspaceId, change: "removed" });
    if (projectId && !this.registry.project(projectId))
      this.#publish("daemon", "project.changed", { projectId, change: "removed" });
    return true;
  }

  async createWorktree(
    projectId: string,
    options: {
      name: string;
      branch?: string | undefined;
      baseRef?: string | undefined;
      groupIds?: string[] | undefined;
    },
  ): Promise<Workspace> {
    const w = await this.registry.createWorktree(projectId, options);
    this.#watchers.watch(w.id, w.path);
    this.#publish("daemon", "workspace.changed", {
      workspaceId: w.id,
      change: "registered",
      workspace: publicWorkspace(w),
    });
    return w;
  }

  async removeWorktree(workspaceId: string, options: { force?: boolean | undefined } = {}): Promise<void> {
    this.#watchers.unwatch(workspaceId);
    try {
      await this.registry.removeWorktree(workspaceId, options);
    } catch (err) {
      const w = this.registry.workspace(workspaceId);
      if (w) this.#watchers.watch(w.id, w.path);
      throw err;
    }
    this.#status.delete(workspaceId);
    this.#publish("daemon", "workspace.changed", { workspaceId, change: "removed" });
  }

  updateProject(
    projectId: string,
    patch: {
      name?: string | undefined;
      groupIds?: string[] | undefined;
      defaultBaseRef?: string | undefined;
    },
  ): Project {
    let p = this.registry.project(projectId);
    if (!p) throw new Error("unknown project");
    if (patch.name !== undefined) p = this.registry.renameProject(projectId, patch.name);
    if (patch.groupIds !== undefined) p = this.registry.setProjectGroups(projectId, patch.groupIds);
    if (patch.defaultBaseRef !== undefined)
      p = this.registry.setProjectBaseRef(projectId, patch.defaultBaseRef);
    this.#publish("daemon", "project.changed", { projectId, change: "updated", project: publicProject(p) });
    return p;
  }

  updateWorkspace(
    workspaceId: string,
    patch: { name?: string | undefined; groupIds?: string[] | undefined },
  ): Workspace {
    let w = this.registry.workspace(workspaceId);
    if (!w) throw new Error("unknown workspace");
    if (patch.name !== undefined) w = this.registry.renameWorkspace(workspaceId, patch.name);
    if (patch.groupIds !== undefined) w = this.registry.setWorkspaceGroups(workspaceId, patch.groupIds);
    this.#publish("daemon", "workspace.changed", {
      workspaceId,
      change: "updated",
      workspace: publicWorkspace(w),
    });
    return w;
  }

  createGroup(input: { name: string; color?: string | undefined; order?: number | undefined }): Group {
    const g = this.registry.createGroup(input);
    this.#publish("daemon", "group.changed", { groupId: g.id, change: "created", group: g });
    return g;
  }

  updateGroup(
    id: string,
    patch: { name?: string | undefined; color?: string | undefined; order?: number | undefined },
  ): Group {
    const g = this.registry.updateGroup(id, patch);
    this.#publish("daemon", "group.changed", { groupId: g.id, change: "updated", group: g });
    return g;
  }

  deleteGroup(id: string): boolean {
    if (!this.registry.deleteGroup(id)) return false;
    this.#publish("daemon", "group.changed", { groupId: id, change: "deleted" });
    return true;
  }

  // ---- status

  /** Branch, ahead/behind, dirty summary; cached until the watcher fires or the TTL passes. */
  status(workspaceId: string): Promise<WorkspaceStatusResult> {
    const w = this.registry.workspace(workspaceId);
    if (!w) return Promise.reject(new Error("unknown workspace"));
    const cached = this.#status.get(workspaceId);
    const now = this.#now();
    if (cached && now - cached.at < this.#ttl) return cached.value;
    const value = (async (): Promise<WorkspaceStatusResult> => {
      if (w.kind === "standalone" || !gitAvailable()) {
        return {
          branch: null,
          upstream: null,
          ahead: 0,
          behind: 0,
          detached: false,
          changes: [],
          truncated: false,
          untrackedCount: 0,
          dirty: false,
          at: now,
        };
      }
      const s = await status(w.path);
      if (s.branch !== (w.branch ?? null)) await this.registry.refreshBranch(workspaceId).catch(() => null);
      return { ...s, dirty: s.changes.length > 0, at: now };
    })();
    value.catch((err) => {
      this.#status.delete(workspaceId);
      this.#log?.warn?.("status failed", {
        workspaceId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
    this.#status.set(workspaceId, { at: now, value });
    return value;
  }

  invalidate(workspaceId: string): void {
    this.#status.delete(workspaceId);
  }

  /** The daemon itself wrote: echo with origin and device so clients can tell it from the agent's edits. */
  wrote(workspaceId: string, paths: string[], deviceId: string): void {
    this.#status.delete(workspaceId);
    this.#publish(`workspace:${workspaceId}`, "workspace.files_changed", {
      workspaceId,
      paths,
      truncated: false,
      origin: "api",
      deviceId,
    });
  }
}

/** The wire shape: no canonical paths, no worktrees directory (spec §3). */
export function publicProject(p: Project): Omit<Project, "rootPath" | "worktreesDir"> {
  const { rootPath: _r, worktreesDir: _w, ...rest } = p;
  return rest;
}

export function publicWorkspace(w: Workspace): Omit<Workspace, "path"> {
  const { path: _p, ...rest } = w;
  return rest;
}
