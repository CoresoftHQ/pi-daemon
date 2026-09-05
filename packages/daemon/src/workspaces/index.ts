// `workspaces`: the project / workspace / group registry, worktrees, git status, the file
// surface, and the watcher behind both. Knows git and the filesystem; knows nothing of pi.

export type { FileMeta, ReadResult, TreeEntry, TreeOptions, TreePage } from "./files.ts";
export * as files from "./files.ts";
export { FileError, resolveOrRefuse } from "./files.ts";
export type { RepoInfo, StatusSummary, WorktreeEntry } from "./git.ts";
export { diff, GitError, git, gitAvailable, repoInfo, status, worktreeList } from "./git.ts";
export type { Group, Project, RegistryOptions, Workspace, WorkspaceKind } from "./registry.ts";
export { RegistryError, WorkspaceRegistry } from "./registry.ts";
export type { Publish, WorkspaceServiceOptions, WorkspaceStatusResult } from "./service.ts";
export { publicProject, publicWorkspace, WorkspaceService } from "./service.ts";
export type { FilesChanged, WorkspaceWatchersOptions } from "./watch.ts";
export { WorkspaceWatchers } from "./watch.ts";
