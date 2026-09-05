// /v1 routes for projects, workspaces, groups, worktrees, status, and the file surface
// (spec §3.1, §5.4). Every file route is a workspaceId plus a relative path; the boundary
// checks live in `workspaces/files`, this file only maps their refusals to HTTP.

import type http from "node:http";
import {
  CreateWorktreeRequest,
  GroupCreate,
  GroupPatch,
  MkdirRequest,
  MoveRequest,
  ProjectPatch,
  RegisterWorkspaceRequest,
  WorkspacePatch,
} from "@coresoft-hq/pi-daemon-contract";
import type { Logger } from "../../os/log.ts";
import type { SessionHost } from "../../sessions/host.ts";
import * as files from "../../workspaces/files.ts";
import { FileError } from "../../workspaces/files.ts";
import { GitError, diff as gitDiff } from "../../workspaces/git.ts";
import type { Workspace } from "../../workspaces/registry.ts";
import { RegistryError } from "../../workspaces/registry.ts";
import type { WorkspaceService } from "../../workspaces/service.ts";
import { publicProject, publicWorkspace } from "../../workspaces/service.ts";
import type { WorkspaceResolver } from "../workspace-resolver.ts";
import { toJsonSummary } from "./json-encode.ts";
import { body, HttpError, type Router, sendJson } from "./router.ts";

export interface WorkspaceRoutesOptions {
  service: WorkspaceService;
  resolver: WorkspaceResolver;
  host: SessionHost;
  maxFileBytes?: number | undefined;
  log?: Logger | undefined;
}

const REGISTRY_STATUS: Record<string, number> = {
  not_found: 404,
  busy: 409,
  exists: 409,
  not_worktree: 409,
  invalid_name: 400,
  invalid_branch: 400,
  unknown_group: 400,
};

function mapError(err: unknown): never {
  if (err instanceof HttpError) throw err;
  if (err instanceof FileError) throw new HttpError(err.status, err.code, err.message, err.extra);
  if (err instanceof RegistryError)
    throw new HttpError(REGISTRY_STATUS[err.code] ?? 400, err.code, err.message);
  if (err instanceof GitError) throw new HttpError(409, "git_failed", err.message);
  throw err;
}

async function readBytes(req: http.IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new HttpError(413, "too_large", "body exceeds maxFileBytes", { maxBytes: limit });
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

function groupFilter(url: URL): string | null | undefined {
  const g = url.searchParams.get("group");
  if (g === null) return undefined;
  return g === "none" ? null : g;
}

function flag(url: URL, name: string): boolean {
  const v = url.searchParams.get(name);
  return v === "1" || v === "true";
}

function parseRange(header: string | undefined, size: number): { start: number; end: number } | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m)
    throw new HttpError(416, "range_not_satisfiable", "only a single bytes= range is supported", { size });
  const [, a, b] = m;
  if (a === "" && b === "") throw new HttpError(416, "range_not_satisfiable", "empty range", { size });
  if (a === "") return { start: Math.max(0, size - Number(b)), end: size };
  const start = Number(a);
  const end = b === "" ? size : Math.min(size, Number(b) + 1);
  if (start >= size || start >= end)
    throw new HttpError(416, "range_not_satisfiable", "range starts past the end", { size });
  return { start, end };
}

export function addWorkspaceRoutes(router: Router, options: WorkspaceRoutesOptions): void {
  const { service, host } = options;
  const registry = service.registry;
  const maxFileBytes = options.maxFileBytes ?? 4 * 1024 * 1024;

  const ws = (id: string): Workspace => {
    const w = registry.workspace(id);
    if (!w) throw new HttpError(404, "unknown_workspace", `no workspace ${id}`);
    return w;
  };
  const relPath = (url: URL, name = "path"): string => {
    const p = url.searchParams.get(name);
    if (p === null || p === "") throw new HttpError(400, "bad_request", `?${name}= is required`);
    return p;
  };
  const writable = () => {
    if (!service.filesWrite)
      throw new HttpError(403, "write_disabled", "this daemon serves files read-only (files.write is off)");
  };

  // ---- projects

  router.add("GET", "/v1/projects", { auth: "member" }, async ({ res, url }) =>
    sendJson(res, 200, { projects: registry.projects(groupFilter(url)).map(publicProject) }),
  );
  router.add("GET", "/v1/projects/:id", { auth: "member" }, async ({ res, params }) => {
    const p = registry.project(params.id ?? "");
    if (!p) throw new HttpError(404, "unknown_project", `no project ${params.id}`);
    sendJson(res, 200, {
      project: publicProject(p),
      workspaces: registry.workspaces({ projectId: p.id }).map(publicWorkspace),
    });
  });
  router.add("PATCH", "/v1/projects/:id", { auth: "member" }, async ({ req, res, params }) => {
    const b = await body(req, ProjectPatch);
    if (!registry.project(params.id ?? ""))
      throw new HttpError(404, "unknown_project", `no project ${params.id}`);
    try {
      sendJson(res, 200, { project: publicProject(service.updateProject(params.id ?? "", b)) });
    } catch (err) {
      mapError(err);
    }
  });
  router.add("POST", "/v1/projects/:id/refresh", { auth: "member" }, async ({ res, params }) => {
    try {
      sendJson(res, 200, {
        workspaces: (await registry.refreshProject(params.id ?? "")).map(publicWorkspace),
      });
    } catch (err) {
      mapError(err);
    }
  });
  router.add("POST", "/v1/projects/:id/worktrees", { auth: "member" }, async ({ req, res, params }) => {
    const b = await body(req, CreateWorktreeRequest);
    try {
      const w = await service.createWorktree(params.id ?? "", b);
      sendJson(res, 201, { workspace: publicWorkspace(w) });
    } catch (err) {
      mapError(err);
    }
  });
  router.add(
    "DELETE",
    "/v1/projects/:id/worktrees/:workspaceId",
    { auth: "member" },
    async ({ res, url, params }) => {
      const w = ws(params.workspaceId ?? "");
      if (w.projectId !== params.id)
        throw new HttpError(404, "unknown_workspace", "that worktree is not in this project");
      try {
        await service.removeWorktree(w.id, { force: flag(url, "force") });
        sendJson(res, 200, { removed: true });
      } catch (err) {
        mapError(err);
      }
    },
  );

  // ---- workspaces

  router.add("GET", "/v1/workspaces", { auth: "member" }, async ({ res, url }) => {
    const projectId = url.searchParams.get("project") ?? undefined;
    sendJson(res, 200, {
      workspaces: registry
        .workspaces({ groupId: groupFilter(url), ...(projectId ? { projectId } : {}) })
        .map(publicWorkspace),
    });
  });
  router.add("POST", "/v1/workspaces", { auth: "owner" }, async ({ req, res }) => {
    const b = await body(req, RegisterWorkspaceRequest);
    try {
      const r = await service.register(b.path, b);
      sendJson(res, 201, {
        ...(r.project ? { project: publicProject(r.project) } : {}),
        workspaces: r.workspaces.map(publicWorkspace),
      });
    } catch (err) {
      mapError(err);
    }
  });
  router.add("GET", "/v1/workspaces/:id", { auth: "member" }, async ({ res, params }) =>
    sendJson(res, 200, { workspace: publicWorkspace(ws(params.id ?? "")) }),
  );
  router.add("PATCH", "/v1/workspaces/:id", { auth: "member" }, async ({ req, res, params }) => {
    const b = await body(req, WorkspacePatch);
    ws(params.id ?? "");
    try {
      sendJson(res, 200, { workspace: publicWorkspace(service.updateWorkspace(params.id ?? "", b)) });
    } catch (err) {
      mapError(err);
    }
  });
  router.add("DELETE", "/v1/workspaces/:id", { auth: "owner" }, async ({ res, params }) => {
    ws(params.id ?? "");
    try {
      service.deregister(params.id ?? "");
      sendJson(res, 200, { removed: true });
    } catch (err) {
      mapError(err);
    }
  });
  router.add("GET", "/v1/workspaces/:id/status", { auth: "member" }, async ({ res, params }) => {
    ws(params.id ?? "");
    try {
      sendJson(res, 200, await service.status(params.id ?? ""));
    } catch (err) {
      mapError(err);
    }
  });
  router.add("GET", "/v1/workspaces/:id/sessions", { auth: "member" }, async ({ res, params }) => {
    const w = ws(params.id ?? "");
    const sessions = host
      .list()
      .filter((s) => s.workspaceId === w.id || options.resolver.workspaceFor(s.cwd)?.workspaceId === w.id)
      .map(toJsonSummary);
    sendJson(res, 200, { sessions });
  });

  // ---- groups

  router.add("GET", "/v1/groups", { auth: "member" }, async ({ res }) =>
    sendJson(res, 200, { groups: registry.groups() }),
  );
  router.add("POST", "/v1/groups", { auth: "member" }, async ({ req, res }) => {
    const b = await body(req, GroupCreate);
    sendJson(res, 201, { group: service.createGroup(b) });
  });
  router.add("GET", "/v1/groups/:id", { auth: "member" }, async ({ res, params }) => {
    const g = registry.group(params.id ?? "");
    if (!g) throw new HttpError(404, "unknown_group", `no group ${params.id}`);
    sendJson(res, 200, {
      group: g,
      projects: registry.projects(g.id).map(publicProject),
      workspaces: registry.workspaces({ groupId: g.id }).map(publicWorkspace),
    });
  });
  router.add("PATCH", "/v1/groups/:id", { auth: "member" }, async ({ req, res, params }) => {
    const b = await body(req, GroupPatch);
    try {
      sendJson(res, 200, { group: service.updateGroup(params.id ?? "", b) });
    } catch (err) {
      mapError(err);
    }
  });
  router.add("DELETE", "/v1/groups/:id", { auth: "member" }, async ({ res, params }) => {
    if (!service.deleteGroup(params.id ?? ""))
      throw new HttpError(404, "unknown_group", `no group ${params.id}`);
    sendJson(res, 200, { removed: true });
  });

  // ---- files (spec §5.4)

  router.add("GET", "/v1/workspaces/:id/tree", { auth: "member" }, async ({ res, url, params }) => {
    const w = ws(params.id ?? "");
    const rel = url.searchParams.get("path") ?? "";
    const depth = url.searchParams.get("depth");
    const limit = url.searchParams.get("limit");
    try {
      const page = await files.tree(w.path, rel, {
        depth: depth ? Number(depth) : undefined,
        limit: limit ? Number(limit) : undefined,
        all: flag(url, "all"),
        cursor: url.searchParams.get("cursor") ?? undefined,
        git: w.kind !== "standalone",
      });
      service.listed(w.id, page.path);
      sendJson(res, 200, page);
    } catch (err) {
      mapError(err);
    }
  });

  const serveFile = async (
    ctx: { req: http.IncomingMessage; res: http.ServerResponse; url: URL; params: Record<string, string> },
    head: boolean,
  ) => {
    const w = ws(ctx.params.id ?? "");
    const rel = relPath(ctx.url);
    let meta: files.FileMeta;
    try {
      meta = files.stat(w.path, rel);
    } catch (err) {
      return mapError(err);
    }
    const inm = ctx.req.headers["if-none-match"];
    if (
      inm &&
      inm
        .split(",")
        .map((s) => s.trim())
        .includes(meta.etag)
    ) {
      ctx.res.writeHead(304, { etag: meta.etag });
      ctx.res.end();
      return;
    }
    const headers: Record<string, string | number> = {
      etag: meta.etag,
      "content-type": meta.contentType,
      "last-modified": new Date(meta.mtime).toUTCString(),
      "accept-ranges": "bytes",
      "x-file-mode": meta.mode.toString(8),
      "x-file-size": meta.size,
    };
    if (head) {
      ctx.res.writeHead(200, { ...headers, "content-length": meta.size });
      ctx.res.end();
      return;
    }
    const rangeHeader = ctx.req.headers.range;
    const range = parseRange(typeof rangeHeader === "string" ? rangeHeader : undefined, meta.size);
    let result: files.ReadResult;
    try {
      result = files.read(w.path, rel, { maxBytes: maxFileBytes, ...(range ? { range } : {}) });
    } catch (err) {
      return mapError(err);
    }
    if (result.range) {
      ctx.res.writeHead(206, {
        ...headers,
        "content-length": result.bytes.length,
        "content-range": `bytes ${result.range.start}-${result.range.end - 1}/${result.range.total}`,
      });
    } else {
      ctx.res.writeHead(200, { ...headers, "content-length": result.bytes.length });
    }
    ctx.res.end(result.bytes);
  };
  router.add("GET", "/v1/workspaces/:id/file", { auth: "member" }, (ctx) => serveFile(ctx, false));
  router.add("HEAD", "/v1/workspaces/:id/file", { auth: "member" }, (ctx) => serveFile(ctx, true));

  router.add("GET", "/v1/workspaces/:id/diff", { auth: "member" }, async ({ res, url, params }) => {
    const w = ws(params.id ?? "");
    const rel = url.searchParams.get("path");
    const base = url.searchParams.get("base") ?? "HEAD";
    if (w.kind === "standalone") {
      sendJson(res, 200, { base, diff: "", truncated: false });
      return;
    }
    if (/^-/.test(base)) throw new HttpError(400, "bad_request", "base must be a ref, not an option");
    let relative: string | undefined;
    if (rel) {
      try {
        relative = files.resolveOrRefuse(w.path, rel).relative;
      } catch (err) {
        mapError(err);
      }
    }
    try {
      const r = await gitDiff(w.path, { path: relative, base, maxBytes: maxFileBytes });
      sendJson(res, 200, { base, diff: r.diff, truncated: r.truncated });
    } catch (err) {
      mapError(err);
    }
  });

  router.add(
    "PUT",
    "/v1/workspaces/:id/file",
    { auth: "member" },
    async ({ req, res, url, params, principal }) => {
      writable();
      const w = ws(params.id ?? "");
      const rel = relPath(url);
      const data = await readBytes(req, maxFileBytes);
      const ifMatch = req.headers["if-match"];
      const ifNoneMatch = req.headers["if-none-match"];
      try {
        const meta = files.write(w.path, rel, data, {
          ifMatch: typeof ifMatch === "string" ? ifMatch : undefined,
          ifNoneMatch: typeof ifNoneMatch === "string" ? ifNoneMatch : undefined,
          parents: flag(url, "parents"),
          force: flag(url, "force"),
        });
        service.wrote(w.id, [meta.path], principal?.deviceId ?? "unknown");
        res.setHeader("etag", meta.etag);
        sendJson(res, 200, { file: meta });
      } catch (err) {
        mapError(err);
      }
    },
  );

  router.add(
    "DELETE",
    "/v1/workspaces/:id/file",
    { auth: "member" },
    async ({ req, res, url, params, principal }) => {
      writable();
      const w = ws(params.id ?? "");
      const rel = relPath(url);
      const ifMatch = req.headers["if-match"];
      try {
        const { relative } = files.resolveOrRefuse(w.path, rel);
        files.remove(w.path, rel, {
          ifMatch: typeof ifMatch === "string" ? ifMatch : undefined,
          recursive: flag(url, "recursive"),
        });
        service.wrote(w.id, [relative], principal?.deviceId ?? "unknown");
        sendJson(res, 200, { removed: true });
      } catch (err) {
        mapError(err);
      }
    },
  );

  router.add(
    "POST",
    "/v1/workspaces/:id/mkdir",
    { auth: "member" },
    async ({ req, res, params, principal }) => {
      writable();
      const w = ws(params.id ?? "");
      const b = await body(req, MkdirRequest);
      try {
        const { relative } = files.resolveOrRefuse(w.path, b.path);
        files.mkdir(w.path, b.path);
        service.wrote(w.id, [relative], principal?.deviceId ?? "unknown");
        sendJson(res, 201, { created: relative });
      } catch (err) {
        mapError(err);
      }
    },
  );

  router.add(
    "POST",
    "/v1/workspaces/:id/move",
    { auth: "member" },
    async ({ req, res, params, principal }) => {
      writable();
      const w = ws(params.id ?? "");
      const b = await body(req, MoveRequest);
      try {
        const from = files.resolveOrRefuse(w.path, b.from).relative;
        const to = files.resolveOrRefuse(w.path, b.to).relative;
        files.move(w.path, b.from, b.to, { overwrite: b.overwrite });
        service.wrote(w.id, [from, to], principal?.deviceId ?? "unknown");
        sendJson(res, 200, { from, to });
      } catch (err) {
        mapError(err);
      }
    },
  );
}
