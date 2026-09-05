import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import { canonicalize, isInside, resolveInside, validateSegment } from "./canon.ts";
import { platform, tmpDir } from "./paths.ts";

let base: string;
let root: string;
let outside: string;

before(() => {
  base = mkdtempSync(path.join(tmpDir(), "pi-daemon-canon-"));
  root = path.join(base, "Root");
  outside = path.join(base, "Outside");
  mkdirSync(path.join(root, "Sub"), { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(path.join(root, "Sub", "File.txt"), "x");
  writeFileSync(path.join(outside, "secret.txt"), "s");
  // A link inside the root pointing outside it. Junctions need no privilege on Windows.
  symlinkSync(outside, path.join(root, "escape"), platform === "win32" ? "junction" : "dir");
});
after(() => {
  rmSync(base, { recursive: true, force: true });
});

test("canonical forms compare equal regardless of typed casing on case-insensitive filesystems", {
  skip: platform === "linux",
}, () => {
  const a = canonicalize(path.join(root, "Sub", "File.txt"));
  const b = canonicalize(path.join(root.toLowerCase(), "sub", "file.txt"));
  assert.equal(a, b);
});

test("drive letter is uppercased and separators normalised on Windows", {
  skip: platform !== "win32",
}, () => {
  const c = canonicalize(root.toLowerCase().replace(/\\/g, "/"));
  assert.match(c, /^[A-Z]:\\/);
  assert.ok(!c.includes("/"));
});

test("a path that does not exist yet canonicalises through its existing ancestor", () => {
  const c = canonicalize(path.join(root, "Sub", "new", "deeper.txt"));
  assert.equal(c, path.join(canonicalize(root), "Sub", "new", "deeper.txt"));
});

test("isInside", () => {
  const r = canonicalize(root);
  assert.equal(isInside(r, r), true);
  assert.equal(isInside(r, path.join(r, "Sub")), true);
  assert.equal(isInside(r, path.join(r, "..")), false);
  assert.equal(isInside(r, canonicalize(outside)), false);
  assert.equal(isInside(r, `${r}2`), false, "a sibling with the root as a string prefix is not inside");
});

test("resolveInside refuses every way out of the root", () => {
  const r = canonicalize(root);
  const reasons = (p: string) => {
    const res = resolveInside(r, p);
    return res.ok ? "ok" : res.reason;
  };
  assert.equal(reasons("Sub/File.txt"), "ok");
  assert.equal(reasons("Sub\\File.txt"), "ok");
  assert.equal(reasons("./Sub/./File.txt"), "ok");
  assert.equal(reasons("Sub/new-file.txt"), "ok", "a file that does not exist yet");
  assert.equal(reasons(""), "empty");
  assert.equal(reasons("../x"), "traversal");
  assert.equal(reasons("Sub/../../x"), "traversal");
  assert.equal(reasons(outside), platform === "win32" ? "drive-relative" : "absolute");
  assert.equal(reasons("/etc/passwd"), "absolute");
  assert.equal(reasons("C:foo"), "drive-relative");
  assert.equal(reasons("\\\\server\\share\\x"), "unc");
  assert.equal(reasons("//server/share/x"), "unc");
  assert.equal(reasons("a\0b"), "null-byte");
  assert.equal(reasons("escape/secret.txt"), "escapes-root", "a symlink whose target leaves the tree");
  assert.equal(reasons("escape"), "escapes-root");
});

test("resolveInside returns a canonical path and the relative form", () => {
  const r = canonicalize(root);
  const res = resolveInside(r, "sub/file.txt");
  assert.ok(res.ok);
  if (res.ok) {
    assert.equal(isInside(r, res.canonical), true);
    assert.equal(res.relative.split(path.sep).length, 2);
  }
});

test("validateSegment rejects names that are legal branches and illegal Windows directories", () => {
  assert.equal(validateSegment("fix-1"), null);
  assert.equal(validateSegment("feature.v2"), null);
  assert.equal(validateSegment("aux"), "reserved-name");
  assert.equal(validateSegment("CON.txt"), "reserved-name");
  assert.equal(validateSegment("com1"), "reserved-name");
  assert.equal(validateSegment("trailing."), "trailing-dot-or-space");
  assert.equal(validateSegment("trailing "), "trailing-dot-or-space");
  assert.equal(validateSegment("a<b"), "invalid-char");
  assert.equal(validateSegment("a:b"), "invalid-char");
  assert.equal(validateSegment(`a${String.fromCharCode(1)}b`), "invalid-char");
  assert.equal(validateSegment("tab\tname"), "invalid-char");
  assert.equal(validateSegment("a/b"), "separator");
  assert.equal(validateSegment(".."), "dot");
  assert.equal(validateSegment(""), "empty");
});
