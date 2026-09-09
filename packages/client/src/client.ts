// The /v1 API as typed methods. One `request` does auth, JSON, and error mapping; everything
// else is a thin named wrapper so a client reads like the docs (docs/clients.md).

import { EventStream, type EventStreamOptions } from "./events.ts";
import { attachTerminal, type TerminalConnection, type TerminalHandlers } from "./terminal.ts";
import type * as T from "./types.ts";

export interface ClientOptions {
  /** e.g. `https://box.tail3f0fb7.ts.net:8790` */
  baseUrl: string;
  token: string;
  fetch?: typeof fetch | undefined;
  WebSocket?: typeof WebSocket | undefined;
}

/** The daemon's one error shape, as an exception. */
export class DaemonError extends Error {
  readonly status: number;
  readonly code: string;
  readonly extra: Record<string, unknown>;
  constructor(status: number, code: string, message: string, extra: Record<string, unknown> = {}) {
    super(message);
    this.name = "DaemonError";
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export interface RequestOptions {
  json?: unknown;
  body?: BodyInit | undefined;
  headers?: Record<string, string> | undefined;
  query?: Record<string, string | number | boolean | undefined> | undefined;
}

export interface FileContent extends T.FileMeta {
  bytes: Uint8Array;
  text(): string;
}

export interface WriteFileOptions {
  ifMatch?: string | undefined;
  createOnly?: boolean | undefined;
  parents?: boolean | undefined;
  force?: boolean | undefined;
}

export class PiDaemonClient {
  readonly baseUrl: string;
  readonly #token: string;
  readonly #fetch: typeof fetch;
  readonly #WebSocket: typeof WebSocket;

  constructor(options: ClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.#token = options.token;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#WebSocket = options.WebSocket ?? globalThis.WebSocket;
  }

  /** Redeem a pairing code (unauthenticated); the result carries the token to construct a client with. */
  static async pair(
    baseUrl: string,
    request: T.PairRedeemRequest,
    fetchImpl: typeof fetch = globalThis.fetch,
  ): Promise<T.PairRedeemResponse> {
    const res = await fetchImpl(`${baseUrl.replace(/\/+$/, "")}/v1/pair/redeem`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
    return (await parse(res)) as T.PairRedeemResponse;
  }

  // ---- the core

  async raw(method: string, path: string, options: RequestOptions = {}): Promise<Response> {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(options.query ?? {}))
      if (v !== undefined) url.searchParams.set(k, String(v));
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.#token}`,
      ...(options.headers ?? {}),
    };
    let body = options.body;
    if (options.json !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(options.json);
    }
    return this.#fetch(url, { method, headers, ...(body !== undefined ? { body } : {}) });
  }

  async request<R>(method: string, path: string, options: RequestOptions = {}): Promise<R> {
    return (await parse(await this.raw(method, path, options))) as R;
  }

  // ---- discovery and access

  health(): Promise<T.Health> {
    return this.request("GET", "/v1/health");
  }

  capabilities(): Promise<T.Capabilities> {
    return this.request("GET", "/v1/capabilities");
  }

  /** A single-use ticket for a WebSocket upgrade where headers cannot be set (browsers). */
  async connectTicket(): Promise<string> {
    const r = await this.request<T.ConnectTicketResponse>("POST", "/v1/connect-tickets");
    return r.ticket;
  }

  readonly devices = {
    list: (): Promise<T.DeviceList> => this.request("GET", "/v1/devices"),
    revoke: (id: string): Promise<void> => this.request("DELETE", `/v1/devices/${enc(id)}`),
    patch: (id: string, patch: T.DevicePatch): Promise<T.DeviceList> =>
      this.request("PATCH", `/v1/devices/${enc(id)}`, { json: patch }),
  };

  // ---- sessions

  readonly sessions = {
    list: (workspaceId?: string): Promise<T.SessionList> =>
      this.request("GET", "/v1/sessions", { query: { workspace: workspaceId } }),
    create: (request: T.CreateSessionRequest = {}): Promise<T.SessionSnapshot> =>
      this.request<T.SessionResponse>("POST", "/v1/sessions", { json: request }).then((r) => r.session),
    get: (id: string): Promise<T.SessionSnapshot> =>
      this.request<T.SessionResponse>("GET", `/v1/sessions/${enc(id)}`).then((r) => r.session),
    /** `idempotencyKey` makes a retry return the same answer instead of prompting twice. */
    prompt: (
      id: string,
      text: string,
      options: { during?: "steer" | "followUp" | undefined; idempotencyKey?: string | undefined } = {},
    ): Promise<T.PromptResponse> =>
      this.request("POST", `/v1/sessions/${enc(id)}/prompt`, {
        json: { text, ...(options.during ? { during: options.during } : {}) } satisfies T.PromptRequest,
        headers: options.idempotencyKey ? { "idempotency-key": options.idempotencyKey } : undefined,
      }),
    steer: (id: string, text: string): Promise<T.SessionSnapshot> =>
      this.#session("POST", id, "steer", { json: { text } }),
    followUp: (id: string, text: string): Promise<T.SessionSnapshot> =>
      this.#session("POST", id, "follow-up", { json: { text } }),
    abort: (id: string): Promise<T.SessionSnapshot> => this.#session("POST", id, "abort"),
    queueMode: (id: string, queue: T.QueueModeRequest["queue"]): Promise<T.SessionSnapshot> =>
      this.#session("POST", id, "queue-mode", { json: { queue } }),
    clearQueue: (id: string): Promise<T.SessionSnapshot> => this.#session("POST", id, "clear-queue"),
    compact: (id: string, request: T.CompactRequest = {}): Promise<T.SessionSnapshot> =>
      this.#session("POST", id, "compact", { json: request }),
    setModel: (id: string, request: T.SetModelRequest): Promise<T.SessionSnapshot> =>
      this.#session("POST", id, "model", { json: request }),
    setThinking: (id: string, request: T.SetThinkingRequest): Promise<T.SessionSnapshot> =>
      this.#session("POST", id, "thinking", { json: request }),
    setName: (id: string, name: string): Promise<T.SessionSnapshot> =>
      this.#session("POST", id, "name", { json: { name } }),
    entries: (id: string, since?: string): Promise<T.EntriesResponse> =>
      this.request("GET", `/v1/sessions/${enc(id)}/entries`, { query: { since } }),
    tree: (id: string): Promise<T.TreeResponse> => this.request("GET", `/v1/sessions/${enc(id)}/tree`),
    stats: (id: string): Promise<T.StatsResponse> => this.request("GET", `/v1/sessions/${enc(id)}/stats`),
    fork: (id: string, request: T.ForkRequest): Promise<T.SessionSnapshot> =>
      this.#session("POST", id, "fork", { json: request }),
  };

  #session(method: string, id: string, op: string, options: RequestOptions = {}): Promise<T.SessionSnapshot> {
    return this.request<T.SessionResponse>(method, `/v1/sessions/${enc(id)}/${op}`, options).then(
      (r) => r.session,
    );
  }

  readonly dialogs = {
    /** First answer wins; a later one throws DaemonError `already_resolved` with who answered. */
    respond: (dialogId: string, answer: T.DialogRespondRequest): Promise<T.DialogRespondResponse> =>
      this.request("POST", `/v1/dialogs/${enc(dialogId)}/respond`, { json: answer }),
  };

  // ---- workspaces, projects, groups

  readonly workspaces = {
    list: (
      filter: { group?: string | null | undefined; project?: string | undefined } = {},
    ): Promise<T.WorkspaceList> =>
      this.request("GET", "/v1/workspaces", {
        query: { group: filter.group === null ? "none" : filter.group, project: filter.project },
      }),
    get: (id: string): Promise<T.Workspace> =>
      this.request<{ workspace: T.Workspace }>("GET", `/v1/workspaces/${enc(id)}`).then((r) => r.workspace),
    /** Owner only: a directory on the daemon's host. */
    register: (request: T.RegisterWorkspaceRequest): Promise<T.RegisterWorkspaceResponse> =>
      this.request("POST", "/v1/workspaces", { json: request }),
    deregister: (id: string): Promise<void> => this.request("DELETE", `/v1/workspaces/${enc(id)}`),
    patch: (id: string, patch: T.WorkspacePatch): Promise<T.Workspace> =>
      this.request<{ workspace: T.Workspace }>("PATCH", `/v1/workspaces/${enc(id)}`, { json: patch }).then(
        (r) => r.workspace,
      ),
    status: (id: string): Promise<T.WorkspaceStatus> =>
      this.request("GET", `/v1/workspaces/${enc(id)}/status`),
    sessions: (id: string): Promise<T.SessionList> =>
      this.request("GET", `/v1/workspaces/${enc(id)}/sessions`),
    tree: (
      id: string,
      options: { path?: string; depth?: number; all?: boolean; cursor?: string; limit?: number } = {},
    ): Promise<T.FileTreeResponse> =>
      this.request("GET", `/v1/workspaces/${enc(id)}/tree`, {
        query: {
          path: options.path,
          depth: options.depth,
          all: options.all ? 1 : undefined,
          cursor: options.cursor,
          limit: options.limit,
        },
      }),
    diff: (id: string, options: { path?: string; base?: string } = {}): Promise<T.DiffResponse> =>
      this.request("GET", `/v1/workspaces/${enc(id)}/diff`, {
        query: { path: options.path, base: options.base },
      }),
    /** Bytes plus the metadata headers. Throws `too_large` (413) above the daemon's limit; use `range`. */
    file: async (
      id: string,
      path: string,
      options: { range?: { start: number; end: number } | undefined; ifNoneMatch?: string | undefined } = {},
    ): Promise<FileContent | null> => {
      const headers: Record<string, string> = {};
      if (options.range) headers.range = `bytes=${options.range.start}-${options.range.end - 1}`;
      if (options.ifNoneMatch) headers["if-none-match"] = options.ifNoneMatch;
      const res = await this.raw("GET", `/v1/workspaces/${enc(id)}/file`, { query: { path }, headers });
      if (res.status === 304) return null;
      if (!res.ok) throw await toError(res);
      const bytes = new Uint8Array(await res.arrayBuffer());
      return {
        path,
        bytes,
        size: Number(res.headers.get("x-file-size") ?? bytes.length),
        mtime: Date.parse(res.headers.get("last-modified") ?? "") || 0,
        mode: Number.parseInt(res.headers.get("x-file-mode") ?? "644", 8),
        etag: res.headers.get("etag") ?? "",
        contentType: res.headers.get("content-type") ?? "application/octet-stream",
        text: () => new TextDecoder().decode(bytes),
      };
    },
    stat: async (id: string, path: string): Promise<T.FileMeta> => {
      const res = await this.raw("HEAD", `/v1/workspaces/${enc(id)}/file`, { query: { path } });
      if (!res.ok)
        throw new DaemonError(res.status, res.status === 404 ? "not_found" : "error", res.statusText);
      return {
        path,
        size: Number(res.headers.get("x-file-size") ?? 0),
        mtime: Date.parse(res.headers.get("last-modified") ?? "") || 0,
        mode: Number.parseInt(res.headers.get("x-file-mode") ?? "644", 8),
        etag: res.headers.get("etag") ?? "",
        contentType: res.headers.get("content-type") ?? "application/octet-stream",
      };
    },
    /** Replacing an existing file needs `ifMatch` (its last ETag); the daemon answers 428/412 otherwise. */
    writeFile: (
      id: string,
      path: string,
      data: Uint8Array | string,
      options: WriteFileOptions = {},
    ): Promise<T.FileMeta> => {
      const headers: Record<string, string> = { "content-type": "application/octet-stream" };
      if (options.ifMatch) headers["if-match"] = options.ifMatch;
      if (options.createOnly) headers["if-none-match"] = "*";
      return this.request<{ file: T.FileMeta }>("PUT", `/v1/workspaces/${enc(id)}/file`, {
        query: { path, parents: options.parents ? 1 : undefined, force: options.force ? 1 : undefined },
        headers,
        body: toBody(data),
      }).then((r) => r.file);
    },
    deleteFile: (
      id: string,
      path: string,
      options: { ifMatch?: string; recursive?: boolean } = {},
    ): Promise<void> =>
      this.request("DELETE", `/v1/workspaces/${enc(id)}/file`, {
        query: { path, recursive: options.recursive ? 1 : undefined },
        headers: options.ifMatch ? { "if-match": options.ifMatch } : undefined,
      }),
    mkdir: (id: string, path: string): Promise<void> =>
      this.request("POST", `/v1/workspaces/${enc(id)}/mkdir`, { json: { path } }),
    move: (id: string, from: string, to: string, overwrite = false): Promise<void> =>
      this.request("POST", `/v1/workspaces/${enc(id)}/move`, { json: { from, to, overwrite } }),
  };

  readonly projects = {
    list: (group?: string | null): Promise<T.ProjectList> =>
      this.request("GET", "/v1/projects", { query: { group: group === null ? "none" : group } }),
    get: (id: string): Promise<{ project: T.Project; workspaces: T.Workspace[] }> =>
      this.request("GET", `/v1/projects/${enc(id)}`),
    patch: (id: string, patch: T.ProjectPatch): Promise<T.Project> =>
      this.request<{ project: T.Project }>("PATCH", `/v1/projects/${enc(id)}`, { json: patch }).then(
        (r) => r.project,
      ),
    refresh: (id: string): Promise<T.WorkspaceList> =>
      this.request("POST", `/v1/projects/${enc(id)}/refresh`),
    createWorktree: (id: string, request: T.CreateWorktreeRequest): Promise<T.Workspace> =>
      this.request<{ workspace: T.Workspace }>("POST", `/v1/projects/${enc(id)}/worktrees`, {
        json: request,
      }).then((r) => r.workspace),
    removeWorktree: (id: string, workspaceId: string, force = false): Promise<void> =>
      this.request("DELETE", `/v1/projects/${enc(id)}/worktrees/${enc(workspaceId)}`, {
        query: { force: force ? 1 : undefined },
      }),
  };

  readonly groups = {
    list: (): Promise<T.GroupList> => this.request("GET", "/v1/groups"),
    create: (request: T.GroupCreate): Promise<T.Group> =>
      this.request<{ group: T.Group }>("POST", "/v1/groups", { json: request }).then((r) => r.group),
    get: (id: string): Promise<T.GroupExpanded> => this.request("GET", `/v1/groups/${enc(id)}`),
    patch: (id: string, patch: T.GroupPatch): Promise<T.Group> =>
      this.request<{ group: T.Group }>("PATCH", `/v1/groups/${enc(id)}`, { json: patch }).then(
        (r) => r.group,
      ),
    delete: (id: string): Promise<void> => this.request("DELETE", `/v1/groups/${enc(id)}`),
  };

  // ---- terminals

  readonly terminals = {
    list: (workspaceId?: string): Promise<T.TerminalList> =>
      this.request("GET", "/v1/terminals", { query: { workspace: workspaceId } }),
    get: (id: string): Promise<T.TerminalInfo> =>
      this.request<{ terminal: T.TerminalInfo }>("GET", `/v1/terminals/${enc(id)}`).then((r) => r.terminal),
    open: (workspaceId: string, request: T.CreateTerminalRequest): Promise<T.TerminalInfo> =>
      this.request<{ terminal: T.TerminalInfo }>("POST", `/v1/workspaces/${enc(workspaceId)}/terminals`, {
        json: request,
      }).then((r) => r.terminal),
    resize: (id: string, cols: number, rows: number): Promise<T.TerminalInfo> =>
      this.request<{ terminal: T.TerminalInfo }>("POST", `/v1/terminals/${enc(id)}/resize`, {
        json: { cols, rows },
      }).then((r) => r.terminal),
    close: (id: string, graceMs?: number): Promise<T.TerminalInfo> =>
      this.request<{ terminal: T.TerminalInfo }>("DELETE", `/v1/terminals/${enc(id)}`, {
        query: { grace: graceMs },
      }).then((r) => r.terminal),
    /** Attach to the byte stream: the snapshot arrives first, then live output. */
    attach: (id: string, handlers: TerminalHandlers): Promise<TerminalConnection> =>
      attachTerminal({
        url: `${this.wsBase()}/v1/terminals/${enc(id)}/stream`,
        ticket: () => this.connectTicket(),
        WebSocket: this.#WebSocket,
        handlers,
      }),
  };

  // ---- events

  /** The event stream with resume and reconnect built in. Close it when done. */
  events(options: EventStreamOptions = {}): EventStream {
    return new EventStream({
      url: `${this.wsBase()}/v1/events`,
      ticket: () => this.connectTicket(),
      WebSocket: this.#WebSocket,
      ...options,
    });
  }

  wsBase(): string {
    return this.baseUrl.replace(/^http/, "ws");
  }
}

const enc = encodeURIComponent;

/** fetch wants an ArrayBuffer-backed view; a plain Uint8Array is one at runtime. */
function toBody(data: Uint8Array | string): BodyInit {
  return (typeof data === "string" ? new TextEncoder().encode(data) : data) as Uint8Array<ArrayBuffer>;
}

async function parse(res: Response): Promise<unknown> {
  if (!res.ok) throw await toError(res);
  if (res.status === 204) return undefined;
  const text = await res.text();
  return text ? JSON.parse(text) : undefined;
}

async function toError(res: Response): Promise<DaemonError> {
  let body: T.ErrorBody | undefined;
  try {
    body = (await res.json()) as T.ErrorBody;
  } catch {
    /* not JSON */
  }
  const { code = "error", message = res.statusText || `HTTP ${res.status}`, ...extra } = body?.error ?? {};
  return new DaemonError(res.status, code, message, extra);
}
