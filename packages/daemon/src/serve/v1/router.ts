// A small router for /v1 over node:http: method + path pattern → handler, JSON bodies validated
// against the contract's schemas, errors in the contract's error shape.

import type http from "node:http";
import type { TSchema } from "typebox";
import { Value } from "typebox/value";
import type { AccessControl, Principal } from "../../access/authenticate.ts";
import { readJson, requirePrincipal, sendError, sendJson } from "../../access/http.ts";

export interface RouteContext {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  url: URL;
  params: Record<string, string>;
  principal: Principal | null;
}

export type RouteFn = (ctx: RouteContext) => Promise<void>;

export interface RouteOptions {
  /** "none" leaves principal null; "member" or "owner" refuses without it. */
  auth: "none" | "member" | "owner";
}

interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  fn: RouteFn;
  auth: RouteOptions["auth"];
}

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly extra: Record<string, unknown>;
  constructor(status: number, code: string, message: string, extra: Record<string, unknown> = {}) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

function compile(path: string): { pattern: RegExp; keys: string[] } {
  const keys: string[] = [];
  const source = path.replace(/\//g, "\\/").replace(/:([A-Za-z]+)/g, (_m, k: string) => {
    keys.push(k);
    return "([^\\/]+)";
  });
  return { pattern: new RegExp(`^${source}$`), keys };
}

export class Router {
  readonly #routes: Route[] = [];
  readonly #access: AccessControl;

  constructor(access: AccessControl) {
    this.#access = access;
  }

  add(method: string, path: string, options: RouteOptions, fn: RouteFn): this {
    const { pattern, keys } = compile(path);
    this.#routes.push({ method, pattern, keys, fn, auth: options.auth });
    return this;
  }

  /** Returns false when no route matched, so another handler may take the request. */
  async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const method = req.method ?? "GET";
    let pathMatched = false;
    for (const r of this.#routes) {
      const m = r.pattern.exec(url.pathname);
      if (!m) continue;
      pathMatched = true;
      if (r.method !== method) continue;
      const params: Record<string, string> = {};
      r.keys.forEach((k, i) => {
        params[k] = decodeURIComponent(m[i + 1] ?? "");
      });
      let principal: Principal | null = null;
      if (r.auth !== "none") {
        principal = requirePrincipal(req, res, this.#access);
        if (!principal) return true;
        if (r.auth === "owner" && principal.role !== "owner") {
          sendError(res, 403, "forbidden", "owner role required");
          return true;
        }
      }
      try {
        await r.fn({ req, res, url, params, principal });
      } catch (err) {
        if (err instanceof HttpError) sendError(res, err.status, err.code, err.message, err.extra);
        else sendError(res, 500, "internal_error", err instanceof Error ? err.message : String(err));
      }
      return true;
    }
    if (pathMatched) {
      sendError(res, 405, "method_not_allowed", `${method} is not allowed here`);
      return true;
    }
    return false;
  }
}

/** Parse and validate a JSON body against a contract schema; 400 with the first errors otherwise. */
export async function body<T extends TSchema>(
  req: http.IncomingMessage,
  schema: T,
): Promise<import("typebox").Static<T>> {
  let value: unknown;
  try {
    value = await readJson(req);
  } catch (err) {
    throw new HttpError(400, "bad_request", err instanceof Error ? err.message : "body must be JSON");
  }
  if (!Value.Check(schema, value)) {
    const errors = [...Value.Errors(schema, value)]
      .slice(0, 5)
      .map((e) => `${(e as { instancePath?: string }).instancePath || "/"}: ${e.message}`);
    throw new HttpError(400, "invalid_body", "body does not match the contract", { errors });
  }
  return value as import("typebox").Static<T>;
}

export { sendError, sendJson };
