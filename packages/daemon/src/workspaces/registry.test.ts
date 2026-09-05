import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { canonicalize } from "../os/canon.ts";
import { gitAvailable, worktreeList } from "./git.ts";
import { RegistryError, WorkspaceRegistry } from "./registry.ts";

const haveGit = gitAvailable();
const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};
const sh = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, env: gitEnv, stdio: ["ignore", "pipe", "pipe"] }).toString();

function tmp(t: { after(fn: () => void): void }): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "pid-reg-"));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
  return canonicalize(dir);
}

function makeRepo(root: string, name: string): string {
  const dir = path.join(root, name);
  mkdirSync(dir);
  sh(dir, "init", "-q", "-b", "main");
  writeFileSync(path.join(dir, "README.md"), `# ${name}\n`);
  sh(dir, "add", ".");
  sh(dir, "commit", "-q", "-m", "init");
  return dir;
}

function registry(
  root: string,
  extra: Partial<ConstructorParameters<typeof WorkspaceRegistry>[0]> = {},
): WorkspaceRegistry {
  return new WorkspaceRegistry({
    file: path.join(root, "state", "workspaces.json"),
    worktreesRoot: path.join(root, "worktrees"),
    ...extra,
  });
}

test("registering a repository discovers its main and existing linked worktrees; a plain directory is standalone", {
  skip: !haveGit,
}, async (t) => {
  const root = tmp(t);
  const repo = makeRepo(root, "app");
  sh(repo, "worktree", "add", "-q", "-b", "feature", path.join(root, "app-feature"));
  const reg = registry(root);
  const r = await reg.register(repo);
  assert.ok(r.project);
  assert.equal(r.project.name, "app");
  assert.equal(r.workspaces.length, 2);
  const main = r.workspaces.find((w) => w.kind === "main");
  const wt = r.workspaces.find((w) => w.kind === "worktree");
  assert.ok(main && wt);
  assert.equal(main.branch, "main");
  assert.equal(wt.branch, "feature");
  assert.equal(wt.path, canonicalize(path.join(root, "app-feature")));
  // registering again is idempotent
  const again = await reg.register(repo);
  assert.equal(again.workspaces[0]?.id, main.id);
  assert.equal(reg.projects().length, 1);

  const plain = path.join(root, "notes");
  mkdirSync(plain);
  const s = await reg.register(plain);
  assert.equal(s.project, undefined);
  assert.equal(s.workspaces[0]?.kind, "standalone");

  // persisted: a fresh registry sees the same things, and the file holds no secrets
  const reg2 = registry(root);
  assert.equal(reg2.workspaces().length, 3);
  assert.ok(readFileSync(path.join(root, "state", "workspaces.json"), "utf8").includes('"version": 1'));

  // deepest match wins
  assert.equal(reg.workspaceForPath(canonicalize(path.join(root, "app-feature", "src")))?.id, wt.id);
  assert.equal(reg.workspaceForPath(canonicalize(root)), undefined);
});

test("worktree names are validated for every OS before git runs, then created and removed", {
  skip: !haveGit,
}, async (t) => {
  const root = tmp(t);
  const repo = makeRepo(root, "app");
  let busy = false;
  const reg = registry(root, { isBusy: () => busy });
  const { project } = await reg.register(repo);
  assert.ok(project);
  const before = (await worktreeList(repo)).length;

  for (const name of ["aux", "fix.", "a<b", "con.txt", "..", "x/y"]) {
    await assert.rejects(
      reg.createWorktree(project.id, { name }),
      (e: unknown) => e instanceof RegistryError && e.code === "invalid_name",
      name,
    );
  }
  await assert.rejects(
    reg.createWorktree(project.id, { name: "ok", branch: "aux/fix" }),
    (e: unknown) => e instanceof RegistryError && e.code === "invalid_branch",
  );
  assert.equal((await worktreeList(repo)).length, before, "git worktree add never ran");

  const w = await reg.createWorktree(project.id, { name: "t1" });
  assert.equal(w.kind, "worktree");
  assert.equal(w.branch, "t1");
  assert.ok(existsSync(path.join(w.path, "README.md")));
  assert.ok(w.path.startsWith(canonicalize(path.join(root, "worktrees"))));
  assert.equal((await worktreeList(repo)).length, before + 1);
  // a second worktree on an existing branch reuses it
  await assert.rejects(
    reg.createWorktree(project.id, { name: "t1" }),
    (e: unknown) => e instanceof RegistryError && e.code === "exists",
  );

  busy = true;
  await assert.rejects(
    reg.removeWorktree(w.id),
    (e: unknown) => e instanceof RegistryError && e.code === "busy",
  );
  assert.ok(existsSync(w.path));
  await reg.removeWorktree(w.id, { force: true });
  assert.ok(!existsSync(w.path));
  assert.equal(reg.workspace(w.id), undefined);
  assert.equal((await worktreeList(repo)).length, before);

  // deregistering the main workspace removes the project from the registry and nothing from disk
  const main = reg.workspaces({ projectId: project.id })[0];
  assert.ok(main);
  assert.throws(
    () => reg.deregister(main.id),
    (e: unknown) => e instanceof RegistryError && e.code === "busy",
  );
  busy = false;
  assert.ok(reg.deregister(main.id));
  assert.equal(reg.project(project.id), undefined);
  assert.ok(existsSync(path.join(repo, "README.md")));
});

test("groups: cross-project membership, an item in two groups, delete removes only the grouping", {
  skip: !haveGit,
}, async (t) => {
  const root = tmp(t);
  const a = makeRepo(root, "a");
  const b = makeRepo(root, "b");
  const reg = registry(root);
  const ra = await reg.register(a);
  const rb = await reg.register(b);
  assert.ok(ra.project && rb.project);
  const wtB = await reg.createWorktree(rb.project.id, { name: "b-feature" });

  const g1 = reg.createGroup({ name: "client" });
  const g2 = reg.createGroup({ name: "urgent", color: "#f00" });
  reg.setProjectGroups(ra.project.id, [g1.id]);
  reg.setWorkspaceGroups(wtB.id, [g1.id, g2.id]);
  assert.throws(
    () => reg.setWorkspaceGroups(wtB.id, ["gr_nope"]),
    (e: unknown) => e instanceof RegistryError && e.code === "unknown_group",
  );

  assert.deepEqual(
    reg.projects(g1.id).map((p) => p.id),
    [ra.project.id],
  );
  assert.deepEqual(
    reg.workspaces({ groupId: g1.id }).map((w) => w.id),
    [wtB.id],
  );
  assert.deepEqual(
    reg.workspaces({ groupId: g2.id }).map((w) => w.id),
    [wtB.id],
  );
  assert.equal(reg.projects(null).length, 1, "project b is ungrouped");

  assert.ok(reg.deleteGroup(g1.id));
  assert.equal(reg.group(g1.id), undefined);
  assert.ok(reg.project(ra.project.id), "the project is still registered");
  assert.ok(existsSync(wtB.path), "nothing on disk was touched");
  assert.deepEqual(
    reg
      .projects(null)
      .map((p) => p.id)
      .sort(),
    [ra.project.id, rb.project.id].sort(),
  );
  assert.deepEqual(reg.workspace(wtB.id)?.groupIds, [g2.id]);
  assert.equal(reg.workspaces({ groupId: null }).length, reg.workspaces().length - 1);
});

test("refreshProject picks up worktrees added and removed outside the daemon", {
  skip: !haveGit,
}, async (t) => {
  const root = tmp(t);
  const repo = makeRepo(root, "app");
  const reg = registry(root);
  const { project } = await reg.register(repo);
  assert.ok(project);
  const extPath = path.join(root, "ext");
  sh(repo, "worktree", "add", "-q", "-b", "ext", extPath);
  const after = await reg.refreshProject(project.id);
  assert.equal(after.length, 2);
  sh(repo, "worktree", "remove", "--force", extPath);
  assert.equal((await reg.refreshProject(project.id)).length, 1);
});
