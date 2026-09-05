// The project / workspace / group registry (spec §3.1). Pure registry metadata, persisted
// atomically. Registering a repository discovers its main and linked worktrees; a directory
// that is not a repository becomes a standalone workspace. Groups are flat, many-to-many, and
// deleting one deletes nothing else.

import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { canonicalize, isInside, validateSegment } from "../os/canon.ts";
import { readJsonSync, writeJsonAtomicSync } from "../os/fsx.ts";
import { crockfordId } from "../os/ids.ts";
import { branchExists, currentBranch, repoInfo, worktreeAdd, worktreeList, worktreeRemove } from "./git.ts";

export interface Project {
  id: string;
  name: string;
  /** Canonical path of the main worktree. */
  rootPath: string;
  displayPath: string;
  createdAt: number;
  groupIds: string[];
  /** Where new worktrees of this project are created. */
  worktreesDir: string;
  defaultBaseRef?: string;
}

export type WorkspaceKind = "main" | "worktree" | "standalone";

export interface Workspace {
  id: string;
  projectId?: string;
  name: string;
  kind: WorkspaceKind;
  /** Canonical. Never leaves the daemon (spec §3). */
  path: string;
  displayPath: string;
  branch?: string;
  createdAt: number;
  groupIds: string[];
}

export interface Group {
  id: string;
  name: string;
  color?: string;
  order?: number;
  createdAt: number;
}

interface RegistryFile {
  version: 1;
  projects: Project[];
  workspaces: Workspace[];
  groups: Group[];
}

export class RegistryError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "RegistryError";
    this.code = code;
  }
}

export interface RegistryOptions {
  file: string;
  /** Default parent for worktrees: <worktreesRoot>/<projectId>/<name>. */
  worktreesRoot: string;
  now?: (() => number) | undefined;
  /** Whether a workspace currently has sessions or terminals attached (blocks removal). */
  isBusy?: ((workspaceId: string) => boolean) | undefined;
}

export class WorkspaceRegistry {
  readonly #o: RegistryOptions;
  readonly #now: () => number;
  #projects = new Map<string, Project>();
  #workspaces = new Map<string, Workspace>();
  #groups = new Map<string, Group>();

  constructor(options: RegistryOptions) {
    this.#o = options;
    this.#now = options.now ?? Date.now;
    const data = readJsonSync<RegistryFile>(options.file);
    for (const p of data?.projects ?? []) this.#projects.set(p.id, p);
    for (const w of data?.workspaces ?? []) this.#workspaces.set(w.id, w);
    for (const g of data?.groups ?? []) this.#groups.set(g.id, g);
  }

  #save(): void {
    mkdirSync(path.dirname(this.#o.file), { recursive: true, mode: 0o700 });
    const out: RegistryFile = {
      version: 1,
      projects: [...this.#projects.values()],
      workspaces: [...this.#workspaces.values()],
      groups: [...this.#groups.values()],
    };
    writeJsonAtomicSync(this.#o.file, out, { mode: 0o600 });
  }

  // ---- queries

  projects(groupId?: string | null): Project[] {
    return [...this.#projects.values()].filter((p) => filterGroup(p, groupId));
  }

  workspaces(
    filter: { groupId?: string | null | undefined; projectId?: string | undefined } = {},
  ): Workspace[] {
    return [...this.#workspaces.values()].filter(
      (w) => filterGroup(w, filter.groupId) && (!filter.projectId || w.projectId === filter.projectId),
    );
  }

  groups(): Group[] {
    return [...this.#groups.values()].sort(
      (a, b) => (a.order ?? 0) - (b.order ?? 0) || a.name.localeCompare(b.name),
    );
  }

  project(id: string): Project | undefined {
    return this.#projects.get(id);
  }

  workspace(id: string): Workspace | undefined {
    return this.#workspaces.get(id);
  }

  group(id: string): Group | undefined {
    return this.#groups.get(id);
  }

  /** The workspace whose root contains this (canonical) path, preferring the deepest. */
  workspaceForPath(canonicalPath: string): Workspace | undefined {
    let best: Workspace | undefined;
    for (const w of this.#workspaces.values()) {
      if (isInside(w.path, canonicalPath) && (!best || w.path.length > best.path.length)) best = w;
    }
    return best;
  }

  workspaceAtPath(canonicalPath: string): Workspace | undefined {
    return [...this.#workspaces.values()].find((w) => w.path === canonicalPath);
  }

  // ---- registration

  /**
   * Register a directory. A git repository yields a project plus a workspace per worktree
   * (existing linked worktrees included); anything else is a standalone workspace.
   */
  async register(
    dir: string,
    options: { name?: string | undefined; groupIds?: string[] | undefined } = {},
  ): Promise<{ project?: Project | undefined; workspaces: Workspace[] }> {
    const canonical = canonicalize(dir);
    if (!existsSync(canonical)) throw new RegistryError("not_found", "directory does not exist");
    const existing = this.workspaceAtPath(canonical);
    if (existing)
      return {
        ...(existing.projectId ? { project: this.#projects.get(existing.projectId) } : {}),
        workspaces: [existing],
      };
    const groupIds = this.#validGroups(options.groupIds ?? []);
    const info = await repoInfo(canonical);
    if (!info) {
      const w: Workspace = {
        id: `ws_${crockfordId(8)}`,
        name: options.name ?? path.basename(canonical),
        kind: "standalone",
        path: canonical,
        displayPath: dir,
        createdAt: this.#now(),
        groupIds,
      };
      this.#workspaces.set(w.id, w);
      this.#save();
      return { workspaces: [w] };
    }
    const mainPath = canonicalize(info.mainWorktree);
    let project = [...this.#projects.values()].find((p) => p.rootPath === mainPath);
    if (!project) {
      project = {
        id: `pr_${crockfordId(8)}`,
        name: options.name ?? path.basename(mainPath),
        rootPath: mainPath,
        displayPath: info.mainWorktree,
        createdAt: this.#now(),
        groupIds,
        worktreesDir: path.join(this.#o.worktreesRoot, path.basename(mainPath)),
      };
      this.#projects.set(project.id, project);
    }
    const created: Workspace[] = [];
    const list = await worktreeList(mainPath).catch(() => []);
    const seen = new Set<string>();
    for (const wt of list) {
      if (wt.bare) continue;
      const p = canonicalize(wt.path);
      seen.add(p);
      if (this.workspaceAtPath(p)) continue;
      const w: Workspace = {
        id: `ws_${crockfordId(8)}`,
        projectId: project.id,
        name: p === mainPath ? project.name : path.basename(p),
        kind: p === mainPath ? "main" : "worktree",
        path: p,
        displayPath: wt.path,
        ...(wt.branch ? { branch: wt.branch } : {}),
        createdAt: this.#now(),
        groupIds: [...groupIds],
      };
      this.#workspaces.set(w.id, w);
      created.push(w);
    }
    if (!seen.has(canonical) && !this.workspaceAtPath(canonical)) {
      // Registered a subdirectory of a repo: the repo is the project; the request root is what they asked for.
      const w: Workspace = {
        id: `ws_${crockfordId(8)}`,
        projectId: project.id,
        name: options.name ?? path.basename(canonical),
        kind: "standalone",
        path: canonical,
        displayPath: dir,
        createdAt: this.#now(),
        groupIds: [...groupIds],
      };
      this.#workspaces.set(w.id, w);
      created.push(w);
    }
    this.#save();
    return { project, workspaces: created.length ? created : this.workspaces({ projectId: project.id }) };
  }

  /** Deregister. Never touches the disk. */
  deregister(workspaceId: string): boolean {
    const w = this.#workspaces.get(workspaceId);
    if (!w) return false;
    if (this.#o.isBusy?.(workspaceId))
      throw new RegistryError("busy", "workspace has sessions or terminals attached");
    this.#workspaces.delete(workspaceId);
    if (w.projectId && this.workspaces({ projectId: w.projectId }).length === 0)
      this.#projects.delete(w.projectId);
    this.#save();
    return true;
  }

  /** Re-scan a project's worktrees (someone ran `git worktree add` in a terminal). */
  async refreshProject(projectId: string): Promise<Workspace[]> {
    const project = this.#projects.get(projectId);
    if (!project) throw new RegistryError("not_found", "unknown project");
    const list = await worktreeList(project.rootPath);
    const present = new Set(list.filter((x) => !x.bare).map((x) => canonicalize(x.path)));
    let changed = false;
    for (const w of this.workspaces({ projectId })) {
      if (w.kind === "worktree" && !present.has(w.path)) {
        this.#workspaces.delete(w.id);
        changed = true;
      }
    }
    for (const wt of list) {
      const p = canonicalize(wt.path);
      if (wt.bare || this.workspaceAtPath(p)) continue;
      const w: Workspace = {
        id: `ws_${crockfordId(8)}`,
        projectId,
        name: path.basename(p),
        kind: p === project.rootPath ? "main" : "worktree",
        path: p,
        displayPath: wt.path,
        ...(wt.branch ? { branch: wt.branch } : {}),
        createdAt: this.#now(),
        groupIds: [...project.groupIds],
      };
      this.#workspaces.set(w.id, w);
      changed = true;
    }
    if (changed) this.#save();
    return this.workspaces({ projectId });
  }

  // ---- worktrees (spec §3.1)

  async createWorktree(
    projectId: string,
    options: {
      name: string;
      branch?: string | undefined;
      baseRef?: string | undefined;
      groupIds?: string[] | undefined;
    },
  ): Promise<Workspace> {
    const project = this.#projects.get(projectId);
    if (!project) throw new RegistryError("not_found", "unknown project");
    const problem = validateSegment(options.name);
    if (problem) throw new RegistryError("invalid_name", `worktree name is not portable: ${problem}`);
    const branch = options.branch ?? options.name;
    for (const seg of branch.split("/")) {
      const p = validateSegment(seg);
      if (p)
        throw new RegistryError(
          "invalid_branch",
          `branch segment "${seg}" is not a portable directory name: ${p}`,
        );
    }
    const dir = path.join(project.worktreesDir, options.name);
    if (existsSync(dir)) throw new RegistryError("exists", "a directory with that name already exists");
    mkdirSync(project.worktreesDir, { recursive: true });
    const exists = await branchExists(project.rootPath, branch);
    await worktreeAdd(project.rootPath, {
      path: dir,
      branch,
      baseRef: options.baseRef ?? project.defaultBaseRef,
      createBranch: !exists,
    });
    const w: Workspace = {
      id: `ws_${crockfordId(8)}`,
      projectId,
      name: options.name,
      kind: "worktree",
      path: canonicalize(dir),
      displayPath: dir,
      branch,
      createdAt: this.#now(),
      groupIds: this.#validGroups(options.groupIds ?? project.groupIds),
    };
    this.#workspaces.set(w.id, w);
    this.#save();
    return w;
  }

  async removeWorktree(workspaceId: string, options: { force?: boolean | undefined } = {}): Promise<void> {
    const w = this.#workspaces.get(workspaceId);
    if (!w) throw new RegistryError("not_found", "unknown workspace");
    if (w.kind !== "worktree" || !w.projectId)
      throw new RegistryError(
        "not_worktree",
        "only linked worktrees can be removed; deregister other workspaces",
      );
    if (this.#o.isBusy?.(workspaceId) && !options.force)
      throw new RegistryError("busy", "workspace has sessions or terminals attached; use force");
    const project = this.#projects.get(w.projectId);
    if (!project) throw new RegistryError("not_found", "unknown project");
    await worktreeRemove(project.rootPath, w.path, options.force ?? false);
    this.#workspaces.delete(workspaceId);
    this.#save();
  }

  async refreshBranch(workspaceId: string): Promise<string | null> {
    const w = this.#workspaces.get(workspaceId);
    if (!w || w.kind === "standalone") return null;
    const b = await currentBranch(w.path);
    if (b !== (w.branch ?? null)) {
      if (b) w.branch = b;
      else delete w.branch;
      this.#save();
    }
    return b;
  }

  // ---- groups

  createGroup(input: { name: string; color?: string | undefined; order?: number | undefined }): Group {
    const g: Group = {
      id: `gr_${crockfordId(8)}`,
      name: input.name.slice(0, 80),
      ...(input.color ? { color: input.color } : {}),
      ...(input.order !== undefined ? { order: input.order } : {}),
      createdAt: this.#now(),
    };
    this.#groups.set(g.id, g);
    this.#save();
    return g;
  }

  updateGroup(
    id: string,
    patch: { name?: string | undefined; color?: string | undefined; order?: number | undefined },
  ): Group {
    const g = this.#groups.get(id);
    if (!g) throw new RegistryError("not_found", "unknown group");
    if (patch.name !== undefined) g.name = patch.name.slice(0, 80);
    if (patch.color !== undefined) g.color = patch.color;
    if (patch.order !== undefined) g.order = patch.order;
    this.#save();
    return g;
  }

  /** Removes the grouping only. Members stay registered and appear as ungrouped. */
  deleteGroup(id: string): boolean {
    if (!this.#groups.delete(id)) return false;
    for (const p of this.#projects.values()) p.groupIds = p.groupIds.filter((g) => g !== id);
    for (const w of this.#workspaces.values()) w.groupIds = w.groupIds.filter((g) => g !== id);
    this.#save();
    return true;
  }

  setProjectGroups(projectId: string, groupIds: string[]): Project {
    const p = this.#projects.get(projectId);
    if (!p) throw new RegistryError("not_found", "unknown project");
    p.groupIds = this.#validGroups(groupIds);
    this.#save();
    return p;
  }

  setWorkspaceGroups(workspaceId: string, groupIds: string[]): Workspace {
    const w = this.#workspaces.get(workspaceId);
    if (!w) throw new RegistryError("not_found", "unknown workspace");
    w.groupIds = this.#validGroups(groupIds);
    this.#save();
    return w;
  }

  renameProject(projectId: string, name: string): Project {
    const p = this.#projects.get(projectId);
    if (!p) throw new RegistryError("not_found", "unknown project");
    p.name = name.slice(0, 80);
    this.#save();
    return p;
  }

  setProjectBaseRef(projectId: string, ref: string): Project {
    const p = this.#projects.get(projectId);
    if (!p) throw new RegistryError("not_found", "unknown project");
    if (ref) p.defaultBaseRef = ref;
    else delete p.defaultBaseRef;
    this.#save();
    return p;
  }

  renameWorkspace(workspaceId: string, name: string): Workspace {
    const w = this.#workspaces.get(workspaceId);
    if (!w) throw new RegistryError("not_found", "unknown workspace");
    w.name = name.slice(0, 80);
    this.#save();
    return w;
  }

  #validGroups(ids: string[]): string[] {
    const out: string[] = [];
    for (const id of ids) {
      if (!this.#groups.has(id)) throw new RegistryError("unknown_group", `unknown group ${id}`);
      if (!out.includes(id)) out.push(id);
    }
    return out;
  }
}

function filterGroup(item: { groupIds: string[] }, groupId?: string | null): boolean {
  if (groupId === undefined) return true;
  if (groupId === null) return item.groupIds.length === 0;
  return item.groupIds.includes(groupId);
}
