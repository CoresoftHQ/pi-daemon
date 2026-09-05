// git, argv only, never a shell string (spec §9). Everything the workspace model needs from a
// repository: is this a repo, where is its main worktree, which linked worktrees exist, what
// is the status, what is the diff, add and remove a worktree.

import { findOnPath, spawnArgv } from "../os/spawn.ts";

export interface GitResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export class GitError extends Error {
  readonly args: readonly string[];
  readonly result: GitResult;
  constructor(args: readonly string[], result: GitResult) {
    super(
      `git ${args.join(" ")} failed (${result.code ?? "signal"}): ${result.stderr.trim() || result.stdout.trim()}`,
    );
    this.name = "GitError";
    this.args = args;
    this.result = result;
  }
}

let gitPath: string | null | undefined;

export function gitAvailable(): boolean {
  if (gitPath === undefined) gitPath = findOnPath("git");
  return gitPath !== null;
}

/** Run git with argv in a directory, capturing output, bounded. */
export function git(
  args: readonly string[],
  cwd: string,
  options: { maxBytes?: number; stdin?: string } = {},
): Promise<GitResult> {
  if (gitPath === undefined) gitPath = findOnPath("git");
  const bin = gitPath;
  const max = options.maxBytes ?? 8 * 1024 * 1024;
  return new Promise((resolve) => {
    if (!bin) return resolve({ code: null, stdout: "", stderr: "git is not installed or not on PATH" });
    const child = spawnArgv(bin, ["-c", "core.quotepath=off", ...args], {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
    });
    let out = "";
    let err = "";
    let truncated = false;
    child.stdout?.on("data", (d: Buffer) => {
      if (out.length < max) out += d.toString();
      else truncated = true;
    });
    child.stderr?.on("data", (d: Buffer) => {
      if (err.length < 64 * 1024) err += d.toString();
    });
    child.on("error", (e) => resolve({ code: null, stdout: out, stderr: `${err}${e.message}` }));
    child.on("close", (code) =>
      resolve({ code, stdout: out, stderr: truncated ? `${err}\n[output truncated]` : err }),
    );
    if (options.stdin !== undefined) child.stdin?.end(options.stdin);
    else child.stdin?.end();
  });
}

async function must(
  args: readonly string[],
  cwd: string,
  options?: { maxBytes?: number; stdin?: string },
): Promise<string> {
  const r = await git(args, cwd, options);
  if (r.code !== 0) throw new GitError(args, r);
  return r.stdout;
}

export interface RepoInfo {
  /** The canonical path of the main worktree. */
  mainWorktree: string;
  /** Whether `path` is itself a linked worktree. */
  isLinkedWorktree: boolean;
  /** The .git directory of the repository (the common dir). */
  commonDir: string;
}

/** Repository membership of a directory, or null when it is not inside one. */
export async function repoInfo(dir: string): Promise<RepoInfo | null> {
  const r = await git(["rev-parse", "--show-toplevel", "--git-common-dir"], dir);
  if (r.code !== 0) return null;
  const [top, common] = r.stdout.trim().split(/\r?\n/);
  if (!top || !common) return null;
  const list = await worktreeList(top).catch(() => []);
  const main = list[0]?.path ?? top;
  return { mainWorktree: main, isLinkedWorktree: normalise(main) !== normalise(top), commonDir: common };
}

function normalise(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/$/, "").toLowerCase();
}

export interface WorktreeEntry {
  path: string;
  head: string | null;
  branch: string | null;
  bare: boolean;
  detached: boolean;
  locked: boolean;
  prunable: boolean;
}

/** `git worktree list --porcelain`. The first entry is the main worktree. */
export async function worktreeList(root: string): Promise<WorktreeEntry[]> {
  const out = await must(["worktree", "list", "--porcelain"], root);
  const entries: WorktreeEntry[] = [];
  let cur: WorktreeEntry | null = null;
  for (const line of out.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) {
      cur = {
        path: line.slice(9),
        head: null,
        branch: null,
        bare: false,
        detached: false,
        locked: false,
        prunable: false,
      };
      entries.push(cur);
    } else if (!cur) continue;
    else if (line.startsWith("HEAD ")) cur.head = line.slice(5);
    else if (line.startsWith("branch ")) cur.branch = line.slice(7).replace(/^refs\/heads\//, "");
    else if (line === "bare") cur.bare = true;
    else if (line === "detached") cur.detached = true;
    else if (line.startsWith("locked")) cur.locked = true;
    else if (line.startsWith("prunable")) cur.prunable = true;
  }
  return entries;
}

export interface StatusSummary {
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  detached: boolean;
  /** Changed paths with their two-letter porcelain code, bounded. */
  changes: Array<{ path: string; code: string }>;
  truncated: boolean;
  untrackedCount: number;
}

/** `git status --porcelain=v2 --branch`, summarised and bounded. */
export async function status(root: string, maxChanges = 500): Promise<StatusSummary> {
  const out = await must(["status", "--porcelain=v2", "--branch", "--untracked-files=all"], root);
  const s: StatusSummary = {
    branch: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    detached: false,
    changes: [],
    truncated: false,
    untrackedCount: 0,
  };
  for (const line of out.split(/\r?\n/)) {
    if (!line) continue;
    if (line.startsWith("# branch.head ")) {
      const v = line.slice(14);
      s.branch = v === "(detached)" ? null : v;
      s.detached = v === "(detached)";
    } else if (line.startsWith("# branch.upstream ")) s.upstream = line.slice(18);
    else if (line.startsWith("# branch.ab ")) {
      const m = /\+(\d+) -(\d+)/.exec(line);
      s.ahead = Number(m?.[1] ?? 0);
      s.behind = Number(m?.[2] ?? 0);
    } else if (line.startsWith("1 ") || line.startsWith("2 ")) {
      const parts = line.split(" ");
      const code = parts[1] ?? "??";
      const p = line.startsWith("2 ")
        ? (parts.slice(9).join(" ").split("\t")[0] ?? "")
        : parts.slice(8).join(" ");
      if (s.changes.length < maxChanges) s.changes.push({ path: p, code });
      else s.truncated = true;
    } else if (line.startsWith("? ")) {
      s.untrackedCount += 1;
      if (s.changes.length < maxChanges) s.changes.push({ path: line.slice(2), code: "??" });
      else s.truncated = true;
    }
  }
  return s;
}

/** Unified diff of the working tree against HEAD (or `base`), for one path or everything. Bounded. */
export async function diff(
  root: string,
  options: { path?: string | undefined; base?: string | undefined; maxBytes?: number | undefined } = {},
): Promise<{ diff: string; truncated: boolean }> {
  const args = ["diff", "--no-color", "--no-ext-diff", options.base ?? "HEAD", "--"];
  if (options.path) args.push(options.path);
  const max = options.maxBytes ?? 4 * 1024 * 1024;
  const r = await git(args, root, { maxBytes: max });
  if (r.code !== 0 && !/bad revision|unknown revision/.test(r.stderr)) throw new GitError(args, r);
  const truncated = r.stderr.includes("[output truncated]");
  return { diff: r.stdout, truncated };
}

export async function worktreeAdd(
  root: string,
  options: { path: string; branch: string; baseRef?: string | undefined; createBranch: boolean },
): Promise<void> {
  const args = options.createBranch
    ? ["worktree", "add", "-b", options.branch, options.path, options.baseRef ?? "HEAD"]
    : ["worktree", "add", options.path, options.branch];
  await must(args, root);
}

export async function worktreeRemove(root: string, worktreePath: string, force: boolean): Promise<void> {
  await must(
    force ? ["worktree", "remove", "--force", worktreePath] : ["worktree", "remove", worktreePath],
    root,
  );
}

export async function branchExists(root: string, branch: string): Promise<boolean> {
  const r = await git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], root);
  return r.code === 0;
}

export async function currentBranch(root: string): Promise<string | null> {
  const r = await git(["symbolic-ref", "--short", "-q", "HEAD"], root);
  return r.code === 0 ? r.stdout.trim() || null : null;
}

/** Which of these paths git ignores. Paths are relative to root. One call per listing. */
export async function ignored(root: string, relPaths: readonly string[]): Promise<Set<string>> {
  if (relPaths.length === 0) return new Set();
  const r = await git(["check-ignore", "--stdin", "-z", "--no-index"], root, {
    stdin: `${relPaths.join("\0")}\0`,
  });
  // exit 1 means "none ignored"; anything else with stderr is a real error we tolerate as "unknown"
  const out = new Set<string>();
  for (const p of r.stdout.split("\0")) if (p) out.add(p);
  return out;
}
