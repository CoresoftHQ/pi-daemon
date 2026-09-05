// Path identity and confinement (spec §7.3, §9).
//
// Canonicalise once at ingest: resolve → realpath.native → drive-letter case → separators.
// Compare canonical forms only. Keep the display form for humans.

import { realpathSync, statSync } from "node:fs";
import path from "node:path";
import { platform } from "./paths.ts";

export interface CanonicalPath {
  /** For comparison and storage. */
  canonical: string;
  /** What the user typed, resolved but not realpath'd. */
  display: string;
}

/** Uppercase the drive letter and normalise separators on Windows; a no-op elsewhere. */
function normaliseWin(p: string): string {
  if (platform !== "win32") return p;
  const n = p.replace(/\//g, "\\");
  return /^[a-z]:/.test(n) ? n.charAt(0).toUpperCase() + n.slice(1) : n;
}

/**
 * Canonical form of a path that may or may not exist yet. The longest existing ancestor is
 * realpath'd (so symlinks and on-disk casing are resolved), and the missing tail is appended.
 */
export function canonicalize(p: string, cwd?: string): string {
  const resolved = path.resolve(cwd ?? process.cwd(), p);
  let existing = resolved;
  let tail: string[] = [];
  for (;;) {
    try {
      const real = realpathSync.native(existing);
      return normaliseWin(tail.length ? path.join(real, ...tail) : real);
    } catch {
      const parent = path.dirname(existing);
      if (parent === existing) return normaliseWin(resolved);
      tail = [path.basename(existing), ...tail];
      existing = parent;
    }
  }
}

export function toCanonicalPath(p: string, cwd?: string): CanonicalPath {
  return { canonical: canonicalize(p, cwd), display: path.resolve(cwd ?? process.cwd(), p) };
}

/** True when `target` is `root` or inside it. Both must already be canonical. */
export function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  if (rel === "") return true;
  if (path.isAbsolute(rel)) return false;
  return !(rel === ".." || rel.startsWith(`..${path.sep}`));
}

export type ResolveInsideFailure =
  | "empty"
  | "absolute"
  | "drive-relative"
  | "unc"
  | "null-byte"
  | "traversal"
  | "escapes-root";

export type ResolveInsideResult =
  | { ok: true; canonical: string; relative: string }
  | { ok: false; reason: ResolveInsideFailure };

/**
 * Resolve a client-supplied relative path against a canonical workspace root, refusing
 * every way of leaving it: absolute paths, drive-relative paths (`C:foo`), UNC paths,
 * `..` traversal, null bytes, and symlinks whose target lies outside (spec §7.3).
 * Works for paths that do not exist yet, so it serves creates as well as reads.
 */
export function resolveInside(root: string, requested: string): ResolveInsideResult {
  if (requested.length === 0) return { ok: false, reason: "empty" };
  if (requested.includes("\0")) return { ok: false, reason: "null-byte" };
  if (/^[\\/]{2}/.test(requested)) return { ok: false, reason: "unc" };
  if (/^[A-Za-z]:/.test(requested)) return { ok: false, reason: "drive-relative" };
  if (path.isAbsolute(requested) || /^[\\/]/.test(requested)) return { ok: false, reason: "absolute" };
  const segments = requested.split(/[\\/]+/).filter((s) => s.length > 0 && s !== ".");
  if (segments.includes("..")) return { ok: false, reason: "traversal" };
  const canonical = canonicalize(path.join(root, ...segments));
  if (!isInside(root, canonical)) return { ok: false, reason: "escapes-root" };
  return { ok: true, canonical, relative: path.relative(root, canonical) };
}

/** Names that are legal git branch names and illegal Windows directory names (spec §9). */
const WINDOWS_RESERVED = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$/i;
const WINDOWS_INVALID_CHARS = /[<>:"|?*]/;
function hasControlCharacter(s: string): boolean {
  for (const ch of s) if (ch.charCodeAt(0) < 32) return true;
  return false;
}
export const WINDOWS_MAX_PATH = 260;

export type SegmentProblem =
  | "empty"
  | "dot"
  | "separator"
  | "reserved-name"
  | "trailing-dot-or-space"
  | "invalid-char";

/**
 * Validate one path segment (a directory or file name) for portability. Enforced on every
 * platform by default — a worktree named `aux` works on Linux and breaks the Windows
 * collaborator who checks it out, which is exactly the kind of "works on my machine" this
 * daemon exists to prevent. `portable: false` relaxes to the current platform's rules.
 */
export function validateSegment(name: string, options: { portable?: boolean } = {}): SegmentProblem | null {
  const portable = options.portable ?? true;
  if (name.length === 0) return "empty";
  if (name === "." || name === "..") return "dot";
  if (/[\\/]/.test(name) || name.includes("\0")) return "separator";
  if (portable || platform === "win32") {
    if (WINDOWS_RESERVED.test(name)) return "reserved-name";
    if (/[. ]$/.test(name)) return "trailing-dot-or-space";
    if (WINDOWS_INVALID_CHARS.test(name)) return "invalid-char";
    if (hasControlCharacter(name)) return "invalid-char";
  }
  return null;
}

/** True when a full path would exceed Windows MAX_PATH. Advisory on other platforms. */
export function exceedsMaxPath(fullPath: string): boolean {
  return fullPath.length >= WINDOWS_MAX_PATH;
}

export function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}
