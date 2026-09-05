// The M6 surface end to end over HTTP: registration and discovery, groups, worktrees with the
// attached-session refusal, session enumeration per workspace, and the file routes with their
// preconditions, the write switch, and the change events both for the daemon's own writes and
// for edits made behind its back.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import type net from "node:net";
import path from "node:path";
import type { TestContext } from "node:test";
import { after, before, test } from "node:test";
import type { AccessControl } from "../../access/authenticate.ts";
import { DeviceStore } from "../../access/devices.ts";
import { ConnectTickets } from "../../access/tickets.ts";
import { canonicalize } from "../../os/canon.ts";
import { tmpDir } from "../../os/paths.ts";
import type { DaemonEvent } from "../../sessions/events.ts";
import { SessionHost } from "../../sessions/host.ts";
import { gitAvailable } from "../../workspaces/git.ts";
import { WorkspaceRegistry } from "../../workspaces/registry.ts";
import { WorkspaceService } from "../../workspaces/service.ts";
import { registryResolver } from "../workspace-resolver.ts";
import { createV1Router } from "./routes.ts";

const FAKE = path.resolve(import.meta.dirname, "..", "..", "..", "test", "fake-pi.mjs");
const launcher = { command: process.execPath, prefix: [FAKE], source: "env" as const };
const env = { PATH: process.env.PATH ?? "" };
const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};
const sh = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, env: gitEnv, stdio: ["ignore", "pipe", "pipe"] }).toString();
const haveGit = gitAvailable();

let root: string;
let repo: string;
let host: SessionHost;
let service: WorkspaceService;
let httpServer: http.Server;
let base: string;
let owner: string;
let member: string;
let memberDeviceId: string;
const events: DaemonEvent[] = [];

before(async () => {
  root = canonicalize(mkdtempSync(path.join(tmpDir(), "pi-daemon-ws-")));
  repo = path.join(root, "app");
  mkdirSync(repo);
  if (haveGit) {
    sh(repo, "init", "-q", "-b", "main");
    writeFileSync(path.join(repo, "README.md"), "# app\n");
    writeFileSync(path.join(repo, ".gitignore"), "node_modules/\n");
    sh(repo, "add", ".");
    sh(repo, "commit", "-q", "-m", "init");
  }
  host = new SessionHost({ launcher, env, sweepIntervalMs: 0 });
  host.log.subscribe((e) => events.push(e));
  const devices = new DeviceStore(path.join(root, "devices.json"));
  const access: AccessControl = { devices, tickets: new ConnectTickets() };
  owner = devices.create({ name: "owner", platform: "test" }).token;
  const m = devices.create({ name: "member", platform: "test" });
  member = m.token;
  memberDeviceId = m.device.id;
  const registry = new WorkspaceRegistry({
    file: path.join(root, "state", "workspaces.json"),
    worktreesRoot: path.join(root, "worktrees"),
    isBusy: (id) =>
      host
        .list()
        .some((s) => s.live && (s.workspaceId === id || workspaces.workspaceFor(s.cwd)?.workspaceId === id)),
  });
  const workspaces = registryResolver(registry);
  service = new WorkspaceService({
    registry,
    publish: (scope, type, payload) => host.log.append(scope, type, payload),
    statusTtlMs: 60_000,
    debounceMs: 100,
  });
  service.start();
  const v1 = createV1Router({
    host,
    workspaces,
    workspaceService: service,
    access,
    capabilities: () => {
      throw new Error("unused");
    },
    version: "0.0.0-test",
    events: { log: host.log, access },
    maxFileBytes: 1024 * 1024,
  });
  httpServer = http.createServer((req, res) => {
    void (async () => {
      if (await v1.handle(req, res)) return;
      res.writeHead(404).end();
    })();
  });
  await new Promise<void>((r) => httpServer.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(httpServer.address() as net.AddressInfo).port}`;
});
after(async () => {
  service.close();
  httpServer.closeAllConnections();
  await new Promise<void>((r) => httpServer.close(() => r()));
  await host.close();
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

interface Reply {
  status: number;
  headers: Headers;
  body: Record<string, unknown>;
  bytes: Buffer;
}

async function call(
  method: string,
  url: string,
  options: { token?: string; json?: unknown; raw?: Buffer | string; headers?: Record<string, string> } = {},
): Promise<Reply> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${options.token ?? member}`,
    ...(options.headers ?? {}),
  };
  let body: Buffer | string | undefined;
  if (options.json !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(options.json);
  } else if (options.raw !== undefined) {
    headers["content-type"] = "application/octet-stream";
    body = options.raw;
  }
  const res = await fetch(base + url, { method, headers, ...(body !== undefined ? { body } : {}) });
  const bytes = Buffer.from(await res.arrayBuffer());
  const text = bytes.toString("utf8");
  const isJson = (res.headers.get("content-type") ?? "").includes("json");
  return {
    status: res.status,
    headers: res.headers,
    body: (isJson && text ? JSON.parse(text) : {}) as Record<string, unknown>,
    bytes,
  };
}

async function waitFor<T>(t: TestContext, pred: () => T | undefined, ms = 8000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = pred();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error(`timed out after ${ms}ms in ${t.name}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const err = (r: Reply) => (r.body.error as { code: string } | undefined)?.code;

let projectId = "";
let mainId = "";
let worktreeId = "";

test("registration is owner-only, discovers the repository, and publishes registry events", {
  skip: !haveGit,
}, async () => {
  assert.equal((await call("POST", "/v1/workspaces", { json: { path: repo } })).status, 403);
  assert.equal(
    (await call("POST", "/v1/workspaces", { token: owner, json: { path: path.join(root, "missing") } }))
      .status,
    404,
  );
  const r = await call("POST", "/v1/workspaces", { token: owner, json: { path: repo } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const project = r.body.project as { id: string; name: string; displayPath: string };
  const ws = r.body.workspaces as Array<{ id: string; kind: string; branch?: string }>;
  projectId = project.id;
  mainId = ws[0]?.id ?? "";
  assert.equal(project.name, "app");
  assert.equal(ws[0]?.kind, "main");
  assert.equal(ws[0]?.branch, "main");
  assert.ok(!("rootPath" in project) && !("path" in (ws[0] ?? {})), "canonical paths never leave the daemon");
  assert.ok(
    events.some(
      (e) => e.type === "project.changed" && (e.payload as { change: string }).change === "registered",
    ),
  );
  assert.ok(
    events.some(
      (e) => e.type === "workspace.changed" && (e.payload as { workspaceId: string }).workspaceId === mainId,
    ),
  );

  const list = await call("GET", "/v1/workspaces");
  assert.equal((list.body.workspaces as unknown[]).length, 1);
  const one = await call("GET", `/v1/workspaces/${mainId}`);
  assert.equal((one.body.workspace as { name: string }).name, "app");
  assert.equal((await call("GET", "/v1/workspaces/ws_nope")).status, 404);
});

test("groups hold projects and workspaces across projects; deleting a group deletes nothing", {
  skip: !haveGit,
}, async () => {
  const g1 = (await call("POST", "/v1/groups", { json: { name: "client", color: "#0af" } })).body.group as {
    id: string;
  };
  const g2 = (await call("POST", "/v1/groups", { json: { name: "urgent" } })).body.group as { id: string };
  assert.equal(
    (await call("PATCH", `/v1/projects/${projectId}`, { json: { groupIds: [g1.id, g2.id] } })).status,
    200,
  );
  assert.equal(
    (await call("PATCH", `/v1/workspaces/${mainId}`, { json: { groupIds: ["gr_nope"] } })).status,
    400,
  );
  assert.equal(
    (await call("PATCH", `/v1/workspaces/${mainId}`, { json: { groupIds: [g2.id], name: "app main" } }))
      .status,
    200,
  );

  const inG1 = await call("GET", `/v1/projects?group=${g1.id}`);
  assert.equal((inG1.body.projects as unknown[]).length, 1);
  const expanded = await call("GET", `/v1/groups/${g2.id}`);
  assert.equal((expanded.body.projects as unknown[]).length, 1);
  assert.equal((expanded.body.workspaces as Array<{ name: string }>)[0]?.name, "app main");
  assert.equal(((await call("GET", "/v1/workspaces?group=none")).body.workspaces as unknown[]).length, 0);

  assert.equal((await call("DELETE", `/v1/groups/${g1.id}`)).status, 200);
  assert.equal((await call("GET", `/v1/groups/${g1.id}`)).status, 404);
  assert.equal(
    ((await call("GET", "/v1/projects")).body.projects as unknown[]).length,
    1,
    "the project survived",
  );
  assert.deepEqual(
    ((await call("GET", `/v1/projects/${projectId}`)).body.project as { groupIds: string[] }).groupIds,
    [g2.id],
  );
  assert.equal(
    (await call("PATCH", `/v1/groups/${g2.id}`, { json: { name: "later", order: 2 } })).status,
    200,
  );
  assert.ok(
    events.some((e) => e.type === "group.changed" && (e.payload as { change: string }).change === "deleted"),
  );
});

test("worktrees: a bad name fails before git, a good one yields a workspace a session can start in, removal refuses while live", {
  skip: !haveGit,
}, async () => {
  const bad = await call("POST", `/v1/projects/${projectId}/worktrees`, { json: { name: "aux" } });
  assert.equal(bad.status, 400);
  assert.equal(err(bad), "invalid_name");
  assert.match((bad.body.error as { message: string }).message, /reserved|portable/i);
  const bad2 = await call("POST", `/v1/projects/${projectId}/worktrees`, {
    json: { name: "fix", branch: "fix/trailing." },
  });
  assert.equal(err(bad2), "invalid_branch");

  const r = await call("POST", `/v1/projects/${projectId}/worktrees`, { json: { name: "feature-1" } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const w = r.body.workspace as { id: string; kind: string; branch: string };
  worktreeId = w.id;
  assert.equal(w.kind, "worktree");
  assert.equal(w.branch, "feature-1");

  const s = await call("POST", "/v1/sessions", { json: { workspaceId: worktreeId } });
  assert.equal(s.status, 201, JSON.stringify(s.body));
  const sessionId = (s.body.session as { id: string }).id;
  const inWs = await call("GET", `/v1/workspaces/${worktreeId}/sessions`);
  assert.deepEqual(
    (inWs.body.sessions as Array<{ id: string }>).map((x) => x.id),
    [sessionId],
  );
  const filtered = await call("GET", `/v1/sessions?workspace=${mainId}`);
  assert.ok(
    !(filtered.body.sessions as Array<{ id: string }>).some((x) => x.id === sessionId),
    "the main workspace does not list it",
  );

  const busy = await call("DELETE", `/v1/projects/${projectId}/worktrees/${worktreeId}`);
  assert.equal(busy.status, 409);
  assert.equal(err(busy), "busy");
  const wrongProject = await call("DELETE", `/v1/projects/pr_nope/worktrees/${worktreeId}`);
  assert.equal(wrongProject.status, 404);
  await host.evict(sessionId, "test");
  assert.equal(
    (await call("DELETE", `/v1/projects/${projectId}/worktrees/${worktreeId}?force=1`)).status,
    200,
  );
  assert.equal((await call("GET", `/v1/workspaces/${worktreeId}`)).status, 404);
  assert.equal(
    ((await call("POST", `/v1/projects/${projectId}/refresh`)).body.workspaces as unknown[]).length,
    1,
  );
});

test("files: tree, file with ETag/Range/If-None-Match, diff, and the write routes with their preconditions and events", {
  skip: !haveGit,
}, async (t) => {
  const tree = await call("GET", `/v1/workspaces/${mainId}/tree`);
  assert.equal(tree.status, 200);
  const names = (tree.body.entries as Array<{ name: string }>).map((e) => e.name);
  assert.ok(names.includes("README.md") && !names.includes(".git"));

  const f = await call("GET", `/v1/workspaces/${mainId}/file?path=README.md`);
  assert.equal(f.status, 200);
  assert.equal(f.bytes.toString(), "# app\n");
  assert.equal(f.headers.get("content-type"), "text/markdown; charset=utf-8");
  const etag = f.headers.get("etag") ?? "";
  assert.ok(etag.startsWith('"'));
  assert.equal(
    (
      await call("GET", `/v1/workspaces/${mainId}/file?path=README.md`, {
        headers: { "if-none-match": etag },
      })
    ).status,
    304,
  );
  const head = await call("HEAD", `/v1/workspaces/${mainId}/file?path=README.md`);
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("x-file-size"), "6");
  assert.equal(head.bytes.length, 0);
  const part = await call("GET", `/v1/workspaces/${mainId}/file?path=README.md`, {
    headers: { range: "bytes=2-4" },
  });
  assert.equal(part.status, 206);
  assert.equal(part.bytes.toString(), "app");
  assert.equal(part.headers.get("content-range"), "bytes 2-4/6");
  assert.equal(
    (await call("GET", `/v1/workspaces/${mainId}/file?path=README.md`, { headers: { range: "bytes=99-" } }))
      .status,
    416,
  );
  assert.equal((await call("GET", `/v1/workspaces/${mainId}/file?path=../devices.json`)).status, 403);
  assert.equal((await call("GET", `/v1/workspaces/${mainId}/file?path=`)).status, 400);
  writeFileSync(path.join(repo, "big.bin"), Buffer.alloc(1024 * 1024 + 1));
  const big = await call("GET", `/v1/workspaces/${mainId}/file?path=big.bin`);
  assert.equal(big.status, 413);
  assert.equal((big.body.error as { size?: number }).size, 1024 * 1024 + 1);

  // writes
  const put428 = await call("PUT", `/v1/workspaces/${mainId}/file?path=README.md`, { raw: "# changed\n" });
  assert.equal(put428.status, 428);
  const put412 = await call("PUT", `/v1/workspaces/${mainId}/file?path=README.md`, {
    raw: "# changed\n",
    headers: { "if-match": '"stale"' },
  });
  assert.equal(put412.status, 412);
  assert.equal(readFileSync(path.join(repo, "README.md"), "utf8"), "# app\n", "untouched");
  const before = events.length;
  const put = await call("PUT", `/v1/workspaces/${mainId}/file?path=README.md`, {
    raw: "# changed\n",
    headers: { "if-match": etag },
  });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  assert.equal(readFileSync(path.join(repo, "README.md"), "utf8"), "# changed\n");
  const echo = events.slice(before).find((e) => e.type === "workspace.files_changed");
  assert.ok(echo, "the daemon's own write is announced");
  assert.deepEqual(echo.payload, {
    workspaceId: mainId,
    paths: ["README.md"],
    truncated: false,
    origin: "api",
    deviceId: memberDeviceId,
  });
  assert.equal(echo.scope, `workspace:${mainId}`);
  const create = await call("PUT", `/v1/workspaces/${mainId}/file?path=src/new.ts&parents=1`, {
    raw: "export {};\n",
    headers: { "if-none-match": "*" },
  });
  assert.equal(create.status, 200);
  assert.equal(
    (
      await call("PUT", `/v1/workspaces/${mainId}/file?path=src/new.ts`, {
        raw: "x",
        headers: { "if-none-match": "*" },
      })
    ).status,
    412,
  );

  const diff = await call("GET", `/v1/workspaces/${mainId}/diff?path=README.md`);
  assert.equal(diff.status, 200);
  assert.match(diff.body.diff as string, /^\+# changed$/m);
  assert.equal((await call("GET", `/v1/workspaces/${mainId}/diff?base=--output=/tmp/x`)).status, 400);
  const status = await call("GET", `/v1/workspaces/${mainId}/status`);
  assert.equal(status.body.branch, "main");
  assert.equal(status.body.dirty, true);
  assert.ok((status.body.changes as Array<{ path: string }>).some((c) => c.path === "README.md"));

  assert.equal(
    (await call("POST", `/v1/workspaces/${mainId}/mkdir`, { json: { path: "docs" } })).status,
    201,
  );
  assert.equal(
    (await call("POST", `/v1/workspaces/${mainId}/mkdir`, { json: { path: "docs" } })).status,
    409,
  );
  assert.equal(
    (
      await call("POST", `/v1/workspaces/${mainId}/move`, {
        json: { from: "src/new.ts", to: "../escaped.ts" },
      })
    ).status,
    403,
  );
  assert.equal(
    (await call("POST", `/v1/workspaces/${mainId}/move`, { json: { from: "src/new.ts", to: "docs/new.ts" } }))
      .status,
    200,
  );
  assert.ok(existsSync(path.join(repo, "docs", "new.ts")));
  assert.equal((await call("DELETE", `/v1/workspaces/${mainId}/file?path=docs`)).status, 409);
  assert.equal((await call("DELETE", `/v1/workspaces/${mainId}/file?path=.git`)).status, 403);
  assert.equal((await call("DELETE", `/v1/workspaces/${mainId}/file?path=docs&recursive=1`)).status, 200);
  assert.ok(!existsSync(path.join(repo, "docs")));

  // the operator's switch
  service.filesWrite = false;
  for (const [method, url, options] of [
    ["PUT", `/v1/workspaces/${mainId}/file?path=x.txt`, { raw: "x" }],
    ["DELETE", `/v1/workspaces/${mainId}/file?path=README.md`, {}],
    ["POST", `/v1/workspaces/${mainId}/mkdir`, { json: { path: "y" } }],
    ["POST", `/v1/workspaces/${mainId}/move`, { json: { from: "README.md", to: "R.md" } }],
  ] as const) {
    const r = await call(method, url, options);
    assert.equal(r.status, 403, `${method} ${url}`);
    assert.equal(err(r), "write_disabled");
  }
  service.filesWrite = true;
  assert.ok(existsSync(path.join(repo, "README.md")));
  void t;
});

test("edits behind the daemon's back: files_changed with origin external, and status sees an external commit", {
  skip: !haveGit,
}, async (t) => {
  const before = events.length;
  writeFileSync(path.join(repo, "external.txt"), "from an editor\n");
  const ev = await waitFor(t, () =>
    events
      .slice(before)
      .find(
        (e) =>
          e.type === "workspace.files_changed" &&
          (e.payload as { origin: string }).origin === "external" &&
          ((e.payload as { paths: string[] }).paths.includes("external.txt") ||
            (e.payload as { truncated: boolean }).truncated),
      ),
  );
  assert.equal((ev.payload as { deviceId?: string }).deviceId, undefined);

  sh(repo, "add", ".");
  sh(repo, "commit", "-q", "-m", "external commit");
  sh(repo, "checkout", "-q", "-b", "elsewhere");
  // The cache TTL is a minute here, so only the watcher's invalidation can make this pass.
  const final = await (async () => {
    const deadline = Date.now() + 8000;
    for (;;) {
      const r = await call("GET", `/v1/workspaces/${mainId}/status`);
      if (r.body.branch === "elsewhere" && r.body.dirty === false) return r.body;
      if (Date.now() > deadline) return r.body;
      await new Promise((res) => setTimeout(res, 100));
    }
  })();
  assert.equal(final.branch, "elsewhere", "the watcher invalidated the cached status");
  assert.equal(final.dirty, false);
  assert.equal(
    ((await call("GET", `/v1/workspaces/${mainId}`)).body.workspace as { branch: string }).branch,
    "elsewhere",
    "the registry followed the branch",
  );
});

test("a standalone directory: no project, no git, empty status, tree still works", async () => {
  const dir = path.join(root, "plain");
  mkdirSync(dir);
  writeFileSync(path.join(dir, "note.txt"), "n");
  const r = await call("POST", "/v1/workspaces", { token: owner, json: { path: dir, name: "Notes" } });
  assert.equal(r.status, 201);
  assert.equal(r.body.project, undefined);
  const id = (r.body.workspaces as Array<{ id: string; kind: string }>)[0]?.id ?? "";
  assert.equal((r.body.workspaces as Array<{ kind: string }>)[0]?.kind, "standalone");
  const status = await call("GET", `/v1/workspaces/${id}/status`);
  assert.equal(status.body.branch, null);
  assert.equal(status.body.dirty, false);
  assert.equal(((await call("GET", `/v1/workspaces/${id}/tree`)).body.entries as unknown[]).length, 1);
  assert.equal((await call("DELETE", `/v1/workspaces/${id}`)).status, 403, "member cannot deregister");
  assert.equal((await call("DELETE", `/v1/workspaces/${id}`, { token: owner })).status, 200);
  assert.ok(existsSync(path.join(dir, "note.txt")), "deregistration deletes nothing");
});
