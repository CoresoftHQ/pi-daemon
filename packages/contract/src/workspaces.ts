// Projects, workspaces, groups, and the file surface (spec §3.1, §5.4). Paths on the wire are
// always relative to a workspace root; the only absolute path is the one an owner registers.

import type { Static } from "typebox";
import { Type } from "typebox";

export const Group = Type.Object({
  id: Type.String(),
  name: Type.String(),
  color: Type.Optional(Type.String()),
  order: Type.Optional(Type.Integer()),
  createdAt: Type.Integer(),
});
export type Group = Static<typeof Group>;

export const Project = Type.Object({
  id: Type.String(),
  name: Type.String(),
  /** For humans. Never a routing key (spec §3). */
  displayPath: Type.String(),
  createdAt: Type.Integer(),
  groupIds: Type.Array(Type.String()),
  defaultBaseRef: Type.Optional(Type.String()),
});
export type Project = Static<typeof Project>;

export const WorkspaceKind = Type.Union([
  Type.Literal("main"),
  Type.Literal("worktree"),
  Type.Literal("standalone"),
]);

export const Workspace = Type.Object({
  id: Type.String(),
  projectId: Type.Optional(Type.String()),
  name: Type.String(),
  kind: WorkspaceKind,
  displayPath: Type.String(),
  branch: Type.Optional(Type.String()),
  createdAt: Type.Integer(),
  groupIds: Type.Array(Type.String()),
});
export type Workspace = Static<typeof Workspace>;

export const ProjectList = Type.Object({ projects: Type.Array(Project) });
export const WorkspaceList = Type.Object({ workspaces: Type.Array(Workspace) });
export const GroupList = Type.Object({ groups: Type.Array(Group) });
export const ProjectResponse = Type.Object({ project: Project });
export const WorkspaceResponse = Type.Object({ workspace: Workspace });
export const GroupResponse = Type.Object({ group: Group });
/** `GET /v1/groups/:id`: the group with its members expanded. */
export const GroupExpanded = Type.Object({
  group: Group,
  projects: Type.Array(Project),
  workspaces: Type.Array(Workspace),
});

/** Owner only: an absolute path on the daemon's host. */
export const RegisterWorkspaceRequest = Type.Object({
  path: Type.String({ minLength: 1 }),
  name: Type.Optional(Type.String({ maxLength: 80 })),
  groupIds: Type.Optional(Type.Array(Type.String())),
});
export type RegisterWorkspaceRequest = Static<typeof RegisterWorkspaceRequest>;
export const RegisterWorkspaceResponse = Type.Object({
  project: Type.Optional(Project),
  workspaces: Type.Array(Workspace),
});

export const ProjectPatch = Type.Object({
  name: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
  groupIds: Type.Optional(Type.Array(Type.String())),
  defaultBaseRef: Type.Optional(Type.String()),
});
export const WorkspacePatch = Type.Object({
  name: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
  groupIds: Type.Optional(Type.Array(Type.String())),
});
export const GroupCreate = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 80 }),
  color: Type.Optional(Type.String({ maxLength: 32 })),
  order: Type.Optional(Type.Integer()),
});
export const GroupPatch = Type.Object({
  name: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
  color: Type.Optional(Type.String({ maxLength: 32 })),
  order: Type.Optional(Type.Integer()),
});

export const CreateWorktreeRequest = Type.Object({
  /** Directory name; must be portable on every OS (spec §9). Also the branch unless `branch` is given. */
  name: Type.String({ minLength: 1, maxLength: 120 }),
  branch: Type.Optional(Type.String({ minLength: 1 })),
  baseRef: Type.Optional(Type.String({ minLength: 1 })),
  groupIds: Type.Optional(Type.Array(Type.String())),
});
export type CreateWorktreeRequest = Static<typeof CreateWorktreeRequest>;

export const WorkspaceStatus = Type.Object({
  branch: Type.Union([Type.String(), Type.Null()]),
  upstream: Type.Union([Type.String(), Type.Null()]),
  ahead: Type.Integer(),
  behind: Type.Integer(),
  detached: Type.Boolean(),
  dirty: Type.Boolean(),
  changes: Type.Array(Type.Object({ path: Type.String(), code: Type.String() })),
  truncated: Type.Boolean(),
  untrackedCount: Type.Integer(),
  /** When this summary was computed. */
  at: Type.Integer(),
});
export type WorkspaceStatus = Static<typeof WorkspaceStatus>;

export const FileKind = Type.Union([
  Type.Literal("file"),
  Type.Literal("dir"),
  Type.Literal("symlink"),
  Type.Literal("other"),
]);
export const FileTreeEntry = Type.Cyclic(
  {
    FileTreeEntry: Type.Object({
      name: Type.String(),
      kind: FileKind,
      size: Type.Integer(),
      mtime: Type.Integer(),
      ignored: Type.Boolean(),
      target: Type.Optional(Type.String({ description: "symlink target, only when inside the workspace" })),
      children: Type.Optional(Type.Array(Type.Ref("FileTreeEntry"))),
    }),
  },
  "FileTreeEntry",
);
export type FileTreeEntry = Static<typeof FileTreeEntry>;
export const FileTreeResponse = Type.Object({
  path: Type.String(),
  entries: Type.Array(FileTreeEntry),
  nextCursor: Type.Optional(Type.String()),
  truncated: Type.Boolean(),
});
export type FileTreeResponse = Static<typeof FileTreeResponse>;

export const FileMeta = Type.Object({
  path: Type.String(),
  size: Type.Integer(),
  mtime: Type.Integer(),
  mode: Type.Integer(),
  etag: Type.String(),
  contentType: Type.String(),
});
export type FileMeta = Static<typeof FileMeta>;
export const FileWriteResponse = Type.Object({ file: FileMeta });

export const DiffResponse = Type.Object({
  base: Type.String(),
  diff: Type.String(),
  truncated: Type.Boolean(),
});
export const MkdirRequest = Type.Object({ path: Type.String({ minLength: 1 }) });
export const MoveRequest = Type.Object({
  from: Type.String({ minLength: 1 }),
  to: Type.String({ minLength: 1 }),
  overwrite: Type.Optional(Type.Boolean()),
});

// ---- events

export const ProjectChanged = Type.Object({
  projectId: Type.String(),
  change: Type.Union([Type.Literal("registered"), Type.Literal("updated"), Type.Literal("removed")]),
  project: Type.Optional(Project),
});
export const WorkspaceChanged = Type.Object({
  workspaceId: Type.String(),
  change: Type.Union([Type.Literal("registered"), Type.Literal("updated"), Type.Literal("removed")]),
  workspace: Type.Optional(Workspace),
});
export const GroupChanged = Type.Object({
  groupId: Type.String(),
  change: Type.Union([Type.Literal("created"), Type.Literal("updated"), Type.Literal("deleted")]),
  group: Type.Optional(Group),
});
/** Coalesced or late, never wrong: a listed path changed, but not every change lists a path. */
export const WorkspaceFilesChanged = Type.Object({
  workspaceId: Type.String(),
  paths: Type.Array(Type.String()),
  truncated: Type.Boolean(),
  origin: Type.Union([Type.Literal("api"), Type.Literal("external")]),
  /** Set for `api`: the device that wrote, so a client can ignore its own echo. */
  deviceId: Type.Optional(Type.String()),
});
export type WorkspaceFilesChanged = Static<typeof WorkspaceFilesChanged>;
