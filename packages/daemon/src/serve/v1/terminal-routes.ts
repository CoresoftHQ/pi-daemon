// /v1 routes for terminals (spec §5.5): open, list, inspect, resize, close. The bytes go on
// the stream in terminal-stream.ts, never through these.

import { CreateTerminalRequest, ResizeTerminalRequest } from "@coresoft-hq/pi-daemon-contract";
import type { Logger } from "../../os/log.ts";
import type { TerminalManager } from "../../terminals/manager.ts";
import {
  TerminalCapError,
  TerminalNotFoundError,
  TerminalsDisabledError,
  TerminalsUnavailableError,
} from "../../terminals/manager.ts";
import type { WorkspaceResolver } from "../workspace-resolver.ts";
import { body, HttpError, type Router, sendJson } from "./router.ts";

export interface TerminalRoutesOptions {
  manager: TerminalManager;
  resolver: WorkspaceResolver;
  log?: Logger | undefined;
}

function mapError(err: unknown): never {
  if (err instanceof HttpError) throw err;
  if (err instanceof TerminalNotFoundError) throw new HttpError(404, "not_found", err.message);
  if (err instanceof TerminalsDisabledError) throw new HttpError(403, "terminals_disabled", err.message);
  if (err instanceof TerminalsUnavailableError)
    throw new HttpError(501, "terminals_unavailable", err.message);
  if (err instanceof TerminalCapError) throw new HttpError(503, "terminal_cap", err.message);
  throw err;
}

export function addTerminalRoutes(router: Router, options: TerminalRoutesOptions): void {
  const { manager } = options;

  router.add("POST", "/v1/workspaces/:id/terminals", { auth: "member" }, async ({ req, res, params }) => {
    const b = await body(req, CreateTerminalRequest);
    const ws = options.resolver.workspaceById(params.id ?? "");
    if (!ws) throw new HttpError(404, "unknown_workspace", `no workspace ${params.id}`);
    try {
      const t = await manager.create({
        workspaceId: ws.workspaceId,
        cwd: ws.cwd,
        cols: b.cols,
        rows: b.rows,
        argv: b.argv,
      });
      sendJson(res, 201, { terminal: t.info() });
    } catch (err) {
      mapError(err);
    }
  });

  router.add("GET", "/v1/terminals", { auth: "member" }, async ({ res, url }) =>
    sendJson(res, 200, { terminals: manager.list(url.searchParams.get("workspace") ?? undefined) }),
  );

  router.add("GET", "/v1/terminals/:id", { auth: "member" }, async ({ res, params }) => {
    try {
      sendJson(res, 200, { terminal: manager.require(params.id ?? "").info() });
    } catch (err) {
      mapError(err);
    }
  });

  router.add("POST", "/v1/terminals/:id/resize", { auth: "member" }, async ({ req, res, params }) => {
    const b = await body(req, ResizeTerminalRequest);
    try {
      const t = manager.require(params.id ?? "");
      t.resize(b.cols, b.rows);
      sendJson(res, 200, { terminal: t.info() });
    } catch (err) {
      mapError(err);
    }
  });

  router.add("DELETE", "/v1/terminals/:id", { auth: "member" }, async ({ res, url, params }) => {
    const id = params.id ?? "";
    const grace = Number(url.searchParams.get("grace") ?? "");
    try {
      const t = manager.require(id);
      if (t.status === "exited") {
        const info = t.info();
        manager.remove(id);
        sendJson(res, 200, { terminal: info });
        return;
      }
      const info = t.info();
      const exit = await manager.close(
        id,
        Number.isFinite(grace) && grace > 0 ? Math.min(grace, 30_000) : undefined,
      );
      sendJson(res, 200, { terminal: { ...info, status: "exited", attachedCount: 0, exit } });
    } catch (err) {
      mapError(err);
    }
  });
}
