// /v1 routes (spec §5.1) other than access (M4), workspaces/files (M6, in workspace-routes.ts) and terminals (M7).

import type http from "node:http";
import type { Capabilities } from "@coresoft-hq/pi-daemon-contract";
import {
  CompactRequest,
  CreateSessionRequest,
  DialogRespondRequest,
  ForkRequest,
  PromptRequest,
  QueueModeRequest,
  SetModelRequest,
  SetNameRequest,
  SetThinkingRequest,
  TextRequest,
} from "@coresoft-hq/pi-daemon-contract";
import type { AccessControl } from "../../access/authenticate.ts";
import type { Logger } from "../../os/log.ts";
import type { SessionHost } from "../../sessions/host.ts";
import { RunnerCapError, SessionLockedError, SessionNotFoundError } from "../../sessions/host.ts";
import type { Session } from "../../sessions/session.ts";
import { SessionBusyError, SessionNotLiveError } from "../../sessions/session.ts";
import type { WorkspaceService } from "../../workspaces/service.ts";
import type { WorkspaceResolver } from "../workspace-resolver.ts";
import type { EventStreamOptions } from "./events.ts";
import { handleEventSse } from "./events.ts";
import { toJsonSnapshot, toJsonSummary } from "./json-encode.ts";
import { body, HttpError, Router, sendJson } from "./router.ts";
import { addWorkspaceRoutes } from "./workspace-routes.ts";

export interface V1RoutesOptions {
  host: SessionHost;
  workspaces: WorkspaceResolver;
  /** M6: projects, groups, worktrees, and the file surface. Absent means those routes are not served. */
  workspaceService?: WorkspaceService | undefined;
  maxFileBytes?: number | undefined;
  access: AccessControl;
  capabilities: () => Capabilities;
  version: string;
  events: EventStreamOptions;
  log?: Logger | undefined;
  /** How long a replayed Idempotency-Key answer stays valid. */
  idempotencyTtlMs?: number | undefined;
  now?: (() => number) | undefined;
}

function mapError(err: unknown): never {
  if (err instanceof HttpError) throw err;
  if (err instanceof SessionNotFoundError) throw new HttpError(404, "not_found", err.message);
  if (err instanceof SessionBusyError) throw new HttpError(409, "busy", err.message);
  if (err instanceof SessionNotLiveError) throw new HttpError(409, "not_live", err.message);
  if (err instanceof SessionLockedError) throw new HttpError(409, "locked", err.message);
  if (err instanceof RunnerCapError) throw new HttpError(503, "runner_cap", err.message);
  throw err;
}

export function createV1Router(options: V1RoutesOptions): Router {
  const { host, access } = options;
  const now = options.now ?? Date.now;
  const router = new Router(access);
  const idempotency = new Map<string, { at: number; status: number; body: unknown }>();
  const ttl = options.idempotencyTtlMs ?? 10 * 60_000;

  const live = async (id: string): Promise<Session> => {
    try {
      return await host.ensureLive(id);
    } catch (err) {
      return mapError(err);
    }
  };
  const snapshot = (s: Session) => ({ session: toJsonSnapshot(s.state) });

  router.add("GET", "/v1/health", { auth: "none" }, async ({ res }) =>
    sendJson(res, 200, { ok: true, version: options.version }),
  );
  router.add("GET", "/v1/capabilities", { auth: "member" }, async ({ res }) =>
    sendJson(res, 200, options.capabilities()),
  );

  router.add("GET", "/v1/sessions", { auth: "member" }, async ({ res, url }) => {
    const workspaceId = url.searchParams.get("workspace");
    const all = host.list();
    const sessions = workspaceId
      ? all.filter(
          (s) =>
            s.workspaceId === workspaceId ||
            options.workspaces.workspaceFor(s.cwd)?.workspaceId === workspaceId,
        )
      : all;
    sendJson(res, 200, { sessions: sessions.map(toJsonSummary) });
  });

  router.add("POST", "/v1/sessions", { auth: "member" }, async ({ req, res }) => {
    const b = await body(req, CreateSessionRequest);
    const ws = options.workspaces.workspaceById(b.workspaceId);
    if (!ws) throw new HttpError(404, "unknown_workspace", `no workspace ${b.workspaceId}`);
    try {
      const s = await host.create({
        workspaceId: ws.workspaceId,
        cwd: ws.cwd,
        ...(b.model ? { model: b.model } : {}),
        ...(b.thinkingLevel ? { thinkingLevel: b.thinkingLevel } : {}),
        ...(b.name ? { name: b.name } : {}),
      });
      sendJson(res, 201, snapshot(s));
    } catch (err) {
      mapError(err);
    }
  });

  router.add("GET", "/v1/sessions/:id", { auth: "member" }, async ({ res, params }) =>
    sendJson(res, 200, snapshot(await live(params.id ?? ""))),
  );

  router.add("GET", "/v1/sessions/:id/entries", { auth: "member" }, async ({ res, url, params }) => {
    const s = await live(params.id ?? "");
    const since = url.searchParams.get("since") ?? undefined;
    const result = await s.getEntries(since).catch(mapError);
    sendJson(res, 200, result ?? { entries: [], leafId: null });
  });

  router.add("POST", "/v1/sessions/:id/prompt", { auth: "member" }, async ({ req, res, params }) => {
    const id = params.id ?? "";
    const key = req.headers["idempotency-key"];
    const cacheKey = typeof key === "string" && key ? `${id}:${key}` : null;
    if (cacheKey) {
      const hit = idempotency.get(cacheKey);
      if (hit && now() - hit.at < ttl) {
        res.setHeader("idempotent-replayed", "true");
        sendJson(res, hit.status, hit.body);
        return;
      }
    }
    const b = await body(req, PromptRequest);
    const s = await live(id);
    try {
      const result = await s.prompt(b.text, { during: b.during });
      const out = {
        ...(result.runId ? { runId: result.runId } : {}),
        queued: result.queued,
        revision: s.state.revision,
      };
      if (cacheKey) {
        idempotency.set(cacheKey, { at: now(), status: 202, body: out });
        if (idempotency.size > 5000)
          for (const [k, v] of idempotency) if (now() - v.at >= ttl) idempotency.delete(k);
      }
      sendJson(res, 202, out);
    } catch (err) {
      mapError(err);
    }
  });

  const textOp = (path: string, op: (s: Session, text: string) => Promise<void>) =>
    router.add("POST", path, { auth: "member" }, async ({ req, res, params }) => {
      const b = await body(req, TextRequest);
      const s = await live(params.id ?? "");
      await op(s, b.text).catch(mapError);
      sendJson(res, 202, snapshot(s));
    });
  textOp("/v1/sessions/:id/steer", (s, t) => s.steer(t));
  textOp("/v1/sessions/:id/follow-up", (s, t) => s.followUp(t));

  router.add("POST", "/v1/sessions/:id/abort", { auth: "member" }, async ({ res, params }) => {
    const s = await live(params.id ?? "");
    await s.abort().catch(mapError);
    sendJson(res, 200, snapshot(s));
  });
  router.add("POST", "/v1/sessions/:id/queue-mode", { auth: "member" }, async ({ req, res, params }) => {
    const b = await body(req, QueueModeRequest);
    const s = await live(params.id ?? "");
    await s.setQueueMode(b.queue, b.mode).catch(mapError);
    sendJson(res, 200, snapshot(s));
  });
  router.add("POST", "/v1/sessions/:id/clear-queue", { auth: "member" }, async ({ res, params }) => {
    const s = await live(params.id ?? "");
    await s.clearQueue().catch(mapError);
    sendJson(res, 200, snapshot(s));
  });
  router.add("POST", "/v1/sessions/:id/compact", { auth: "member" }, async ({ req, res, params }) => {
    const b = await body(req, CompactRequest);
    const s = await live(params.id ?? "");
    await s.compact(b.customInstructions).catch(mapError);
    sendJson(res, 202, snapshot(s));
  });
  router.add("POST", "/v1/sessions/:id/model", { auth: "member" }, async ({ req, res, params }) => {
    const b = await body(req, SetModelRequest);
    const s = await live(params.id ?? "");
    await s.setModel(b.model.provider, b.model.id).catch(mapError);
    sendJson(res, 200, snapshot(s));
  });
  router.add("POST", "/v1/sessions/:id/thinking", { auth: "member" }, async ({ req, res, params }) => {
    const b = await body(req, SetThinkingRequest);
    const s = await live(params.id ?? "");
    await s.setThinking(b.thinkingLevel).catch(mapError);
    sendJson(res, 200, snapshot(s));
  });
  router.add("POST", "/v1/sessions/:id/name", { auth: "member" }, async ({ req, res, params }) => {
    const b = await body(req, SetNameRequest);
    const s = await live(params.id ?? "");
    await s.setName(b.name).catch(mapError);
    sendJson(res, 200, snapshot(s));
  });
  router.add("GET", "/v1/sessions/:id/tree", { auth: "member" }, async ({ res, params }) => {
    const s = await live(params.id ?? "");
    sendJson(res, 200, { tree: await s.getTree().catch(mapError) });
  });
  router.add("POST", "/v1/sessions/:id/fork", { auth: "member" }, async ({ req, res, params }) => {
    const b = await body(req, ForkRequest);
    const s = await live(params.id ?? "");
    await s.fork(b.entryId).catch(mapError);
    sendJson(res, 200, snapshot(s));
  });
  router.add("GET", "/v1/sessions/:id/stats", { auth: "member" }, async ({ res, params }) => {
    const s = await live(params.id ?? "");
    sendJson(res, 200, { stats: await s.getStats().catch(mapError) });
  });

  router.add(
    "POST",
    "/v1/dialogs/:id/respond",
    { auth: "member" },
    async ({ req, res, params, principal }) => {
      const b = await body(req, DialogRespondRequest);
      const result = host.respondDialog(params.id ?? "", b, principal?.deviceId ?? "unknown");
      if (result.ok) {
        sendJson(res, 200, { dialogId: result.dialog.dialogId, resolution: result.dialog.resolution });
        return;
      }
      if (result.reason === "unknown") throw new HttpError(404, "not_found", "unknown dialog");
      throw new HttpError(409, "already_resolved", "this dialog was already resolved", {
        resolution: result.resolution,
        ...(result.answeredBy ? { answeredBy: result.answeredBy } : {}),
      });
    },
  );

  router.add("GET", "/v1/events/sse", { auth: "member" }, async ({ req, res }) =>
    handleEventSse(req, res, options.events),
  );

  if (options.workspaceService) {
    addWorkspaceRoutes(router, {
      service: options.workspaceService,
      resolver: options.workspaces,
      host,
      maxFileBytes: options.maxFileBytes,
      log: options.log,
    });
  }

  return router;
}

export type { http };
