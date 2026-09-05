// The read-write file API core (spec §5.4, §7.3). The one place the daemon serves bytes itself,
// so the one place its own path checks carry weight: every request is joined to the workspace
// root, realpath'd, and refused unless the result is still inside — `..`, absolute, drive-
// relative, UNC, null bytes, and symlinks whose target leaves the tree all fail the same way.

import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  readSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  unlinkSync,
} from "node:fs";
import path from "node:path";
import type { ResolveInsideFailure } from "../os/canon.ts";
import { canonicalize, isInside, resolveInside } from "../os/canon.ts";
import { writeFileAtomicSync } from "../os/fsx.ts";
import { ignored as gitIgnored } from "./git.ts";

export class FileError extends Error {
  readonly status: number;
  readonly code: string;
  readonly extra: Record<string, unknown>;
  constructor(status: number, code: string, message: string, extra: Record<string, unknown> = {}) {
    super(message);
    this.name = "FileError";
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

/** A 403 that names the rule, never the path (spec §7.3). */
function refuse(reason: ResolveInsideFailure): never {
  throw new FileError(403, "outside_workspace", "path is not inside the workspace", { rule: reason });
}

/** Control and line-separator characters have no business in a path a client sends (spec §7.3). */
function hasForbiddenCharacter(s: string): boolean {
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    if (c < 0x20 || c === 0x7f || c === 0x2028 || c === 0x2029) return true;
  }
  return false;
}

export function resolveOrRefuse(root: string, rel: string): { canonical: string; relative: string } {
  if (hasForbiddenCharacter(rel)) {
    throw new FileError(403, "outside_workspace", "path is not inside the workspace", {
      rule: "control-character",
    });
  }
  const r = resolveInside(root, rel);
  if (!r.ok) refuse(r.reason);
  return { canonical: r.canonical, relative: r.relative.split(path.sep).join("/") };
}

/**
 * Like `resolveOrRefuse`, but the final component is not followed — for deleting or renaming
 * a symlink *as a link*. The parent still has to resolve inside the root, and every syntactic
 * rule still applies; only "the link points outside" is allowed through, because removing such
 * a link is exactly what a client wants and touches nothing outside.
 */
export function resolveLinkOrRefuse(root: string, rel: string): { lexical: string; relative: string } {
  if (hasForbiddenCharacter(rel)) {
    throw new FileError(403, "outside_workspace", "path is not inside the workspace", {
      rule: "control-character",
    });
  }
  const full = resolveInside(root, rel);
  if (!full.ok && full.reason !== "escapes-root") refuse(full.reason);
  const segments = rel.split(/[\\/]+/).filter((s) => s.length > 0 && s !== ".");
  const last = segments.pop();
  if (!last) throw new FileError(403, "protected", "the workspace root cannot be deleted or moved");
  const parent = segments.length > 0 ? resolveInside(root, segments.join("/")) : null;
  if (parent && !parent.ok) refuse(parent.reason);
  const parentCanonical = parent ? parent.canonical : root;
  const parentRelative = parent ? parent.relative.split(path.sep).join("/") : "";
  return {
    lexical: path.join(parentCanonical, last),
    relative: parentRelative ? `${parentRelative}/${last}` : last,
  };
}

function lexists(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/** Unlink a symlink; on Windows a directory link needs rmdir. */
function unlinkLink(p: string): void {
  try {
    unlinkSync(p);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EPERM" || code === "EISDIR" || code === "EACCES") rmdirSync(p);
    else throw err;
  }
}

export interface TreeEntry {
  name: string;
  kind: "file" | "dir" | "symlink" | "other";
  size: number;
  mtime: number;
  ignored: boolean;
  /** Where a symlink points, only when the target is inside the workspace. */
  target?: string;
  children?: TreeEntry[];
}

export interface TreeOptions {
  depth?: number | undefined;
  /** Include .git and git-ignored entries. */
  all?: boolean | undefined;
  cursor?: string | undefined;
  limit?: number | undefined;
  /** Root is a git repo: consult check-ignore. */
  git?: boolean | undefined;
}

export interface TreePage {
  path: string;
  entries: TreeEntry[];
  nextCursor?: string | undefined;
  truncated: boolean;
}

const MAX_DEPTH = 4;
const DEFAULT_LIMIT = 500;

/** A directory listing, paged by cursor so node_modules cannot become a 40 MB response. */
export async function tree(root: string, rel: string, options: TreeOptions = {}): Promise<TreePage> {
  const { canonical, relative } = resolveOrRefuse(root, rel || ".");
  let st: Stats;
  try {
    st = statSync(canonical);
  } catch {
    throw new FileError(404, "not_found", "no such directory");
  }
  if (!st.isDirectory()) throw new FileError(409, "not_a_directory", "path is a file");
  const depth = Math.min(Math.max(options.depth ?? 1, 1), MAX_DEPTH);
  const limit = Math.min(Math.max(options.limit ?? DEFAULT_LIMIT, 1), 5000);
  const all = options.all ?? false;

  const listDir = (dir: string): TreeEntry[] => {
    let names: string[];
    try {
      names = readdirSync(dir).sort((a, b) => a.localeCompare(b));
    } catch {
      return [];
    }
    const out: TreeEntry[] = [];
    for (const name of names) {
      if (!all && name === ".git") continue;
      const full = path.join(dir, name);
      let ls: Stats;
      try {
        ls = lstatSync(full);
      } catch {
        continue;
      }
      const entry: TreeEntry = {
        name,
        kind: ls.isSymbolicLink() ? "symlink" : ls.isDirectory() ? "dir" : ls.isFile() ? "file" : "other",
        size: ls.size,
        mtime: Math.trunc(ls.mtimeMs),
        ignored: false,
      };
      if (entry.kind === "symlink") {
        try {
          const target = canonicalize(path.resolve(dir, readlinkSync(full)));
          if (isInside(root, target)) entry.target = path.relative(root, target).split(path.sep).join("/");
        } catch {
          /* dangling */
        }
      }
      out.push(entry);
    }
    return out;
  };

  const top = listDir(canonical);
  // gitignore awareness: one check-ignore call for the whole top-level page.
  if (options.git !== false) {
    const relPaths = top.map((e) => (relative ? `${relative}/${e.name}` : e.name));
    const ig = await gitIgnored(root, relPaths).catch(() => new Set<string>());
    for (const e of top) e.ignored = ig.has(relative ? `${relative}/${e.name}` : e.name);
  }
  const visible = all ? top : top.filter((e) => !e.ignored);
  const cursor = options.cursor;
  const start = cursor
    ? Math.max(
        0,
        visible.findIndex((e) => e.name > cursor),
      )
    : 0;
  const page = visible.slice(start, start + limit);
  const truncated = start + limit < visible.length;

  const descend = (entries: TreeEntry[], dir: string, level: number) => {
    if (level >= depth) return;
    for (const e of entries) {
      if (e.kind !== "dir") continue;
      const children = listDir(path.join(dir, e.name))
        .filter((c) => all || !c.ignored)
        .slice(0, 200);
      e.children = children;
      descend(children, path.join(dir, e.name), level + 1);
    }
  };
  descend(page, canonical, 1);

  return {
    path: relative,
    entries: page,
    truncated,
    ...(truncated ? { nextCursor: page[page.length - 1]?.name } : {}),
  };
}

export interface FileMeta {
  path: string;
  size: number;
  mtime: number;
  mode: number;
  etag: string;
  contentType: string;
}

const SNIFF = 8192;

function sniffContentType(fd: number, size: number, name: string): string {
  const n = Math.min(SNIFF, size);
  const buf = Buffer.alloc(n);
  readSync(fd, buf, 0, n, 0);
  if (buf.includes(0)) return "application/octet-stream";
  const ext = path.extname(name).toLowerCase();
  const map: Record<string, string> = {
    ".json": "application/json",
    ".md": "text/markdown",
    ".html": "text/html",
    ".css": "text/css",
    ".js": "text/javascript",
    ".mjs": "text/javascript",
    ".ts": "text/typescript",
    ".svg": "image/svg+xml",
    ".xml": "application/xml",
    ".yml": "application/yaml",
    ".yaml": "application/yaml",
  };
  return `${map[ext] ?? "text/plain"}; charset=utf-8`;
}

function etagOf(file: string, st: Stats): string {
  // mtime + size + a content hash: cheap to compare, honest about content.
  const hash = createHash("sha256").update(readFileSync(file)).digest("hex").slice(0, 32);
  return `"${Math.trunc(st.mtimeMs).toString(36)}-${st.size.toString(36)}-${hash}"`;
}

export function stat(root: string, rel: string): FileMeta {
  const { canonical, relative } = resolveOrRefuse(root, rel);
  let st: Stats;
  try {
    st = statSync(canonical);
  } catch {
    throw new FileError(404, "not_found", "no such file");
  }
  if (!st.isFile()) throw new FileError(409, "not_a_file", "path is not a regular file");
  const fd = openSync(canonical, "r");
  let contentType: string;
  try {
    contentType = sniffContentType(fd, st.size, canonical);
  } finally {
    closeSync(fd);
  }
  return {
    path: relative,
    size: st.size,
    mtime: Math.trunc(st.mtimeMs),
    mode: st.mode & 0o777,
    etag: etagOf(canonical, st),
    contentType,
  };
}

export interface ReadOptions {
  maxBytes?: number | undefined;
  /** Byte range, inclusive start, exclusive end. */
  range?: { start: number; end: number } | undefined;
}

export interface ReadResult extends FileMeta {
  bytes: Buffer;
  /** Set when a range was served. */
  range?: { start: number; end: number; total: number };
}

/** Read a file, capped at maxBytes unless a range is given (413 with the size otherwise). */
export function read(root: string, rel: string, options: ReadOptions = {}): ReadResult {
  const meta = stat(root, rel);
  const { canonical } = resolveOrRefuse(root, rel);
  const max = options.maxBytes ?? 4 * 1024 * 1024;
  if (options.range) {
    const start = Math.max(0, options.range.start);
    const end = Math.min(meta.size, options.range.end);
    if (start >= end)
      throw new FileError(416, "range_not_satisfiable", "range is empty", { size: meta.size });
    if (end - start > max)
      throw new FileError(413, "too_large", "range exceeds the limit", { size: meta.size, maxBytes: max });
    const fd = openSync(canonical, "r");
    try {
      const buf = Buffer.alloc(end - start);
      readSync(fd, buf, 0, end - start, start);
      return { ...meta, bytes: buf, range: { start, end, total: meta.size } };
    } finally {
      closeSync(fd);
    }
  }
  if (meta.size > max)
    throw new FileError(413, "too_large", "file exceeds the limit; request a range", {
      size: meta.size,
      maxBytes: max,
    });
  return { ...meta, bytes: readFileSync(canonical) };
}

export interface WriteOptions {
  /** Required to replace an existing file, unless force. */
  ifMatch?: string | undefined;
  /** "*" to create only. */
  ifNoneMatch?: string | undefined;
  parents?: boolean | undefined;
  force?: boolean | undefined;
}

/** Create or replace, atomically, byte for byte, mode preserved. */
export function write(root: string, rel: string, data: Buffer, options: WriteOptions = {}): FileMeta {
  const { canonical } = resolveOrRefuse(root, rel);
  const exists = existsSync(canonical);
  if (exists) {
    if (!statSync(canonical).isFile()) throw new FileError(409, "not_a_file", "path is not a regular file");
    if (options.ifNoneMatch === "*") throw new FileError(412, "exists", "file already exists");
    if (!options.force) {
      if (!options.ifMatch)
        throw new FileError(
          428,
          "precondition_required",
          "replacing a file requires If-Match with the ETag you last read",
        );
      const current = etagOf(canonical, statSync(canonical));
      if (options.ifMatch !== current)
        throw new FileError(412, "precondition_failed", "the file changed since you read it", {
          etag: current,
        });
    }
  } else {
    const parent = path.dirname(canonical);
    if (!existsSync(parent)) {
      if (!options.parents)
        throw new FileError(404, "parent_missing", "parent directory does not exist; use parents=1 or mkdir");
      mkdirSync(parent, { recursive: true });
    }
  }
  writeFileAtomicSync(canonical, data);
  return stat(root, rel);
}

export function mkdir(root: string, rel: string): void {
  const { canonical } = resolveOrRefuse(root, rel);
  if (existsSync(canonical)) throw new FileError(409, "exists", "already exists");
  mkdirSync(canonical, { recursive: true });
}

export interface RemoveOptions {
  ifMatch?: string | undefined;
  recursive?: boolean | undefined;
}

/**
 * Delete. Directories need recursive; the root and .git are never deletable; a symlink is
 * removed as a link and never followed — which is why this works on the lexical path, not the
 * realpath: the realpath of `link` *is* its target.
 */
export function remove(root: string, rel: string, options: RemoveOptions = {}): { relative: string } {
  const { lexical, relative } = resolveLinkOrRefuse(root, rel);
  if (relative === ".git" || relative.startsWith(".git/"))
    throw new FileError(403, "protected", "the workspace root and .git cannot be deleted through the API");
  let ls: Stats;
  try {
    ls = lstatSync(lexical);
  } catch {
    throw new FileError(404, "not_found", "no such entry");
  }
  if (ls.isSymbolicLink()) {
    unlinkLink(lexical);
    return { relative };
  }
  if (ls.isDirectory()) {
    if (!options.recursive) throw new FileError(409, "is_directory", "directories need recursive=1");
    rmSync(lexical, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    return { relative };
  }
  if (options.ifMatch) {
    const current = etagOf(lexical, ls);
    if (options.ifMatch !== current)
      throw new FileError(412, "precondition_failed", "the file changed since you read it", {
        etag: current,
      });
  }
  rmSync(lexical, { force: true });
  return { relative };
}

/**
 * Rename within the workspace. A plain rename: git sees delete + add until staged. Both ends
 * are lexical, so a link is moved as a link and a destination that is a link is replaced, not
 * written through.
 */
export function move(
  root: string,
  fromRel: string,
  toRel: string,
  options: { overwrite?: boolean | undefined } = {},
): { from: string; to: string } {
  const from = resolveLinkOrRefuse(root, fromRel);
  const to = resolveLinkOrRefuse(root, toRel);
  if (from.relative === ".git" || from.relative.startsWith(".git/") || to.relative === ".git")
    throw new FileError(403, "protected", ".git cannot be moved through the API");
  if (!lexists(from.lexical)) throw new FileError(404, "not_found", "no such entry");
  if (lexists(to.lexical) && !options.overwrite) throw new FileError(409, "exists", "destination exists");
  mkdirSync(path.dirname(to.lexical), { recursive: true });
  renameSync(from.lexical, to.lexical);
  return { from: from.relative, to: to.relative };
}
