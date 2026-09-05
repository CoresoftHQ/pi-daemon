import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { canonicalize } from "../os/canon.ts";
import { FileError, mkdir, move, read, remove, stat, tree, write } from "./files.ts";
import { gitAvailable } from "./git.ts";

const win = process.platform === "win32";
const posix = !win;

function fixture(t: { after(fn: () => void): void }): { root: string; outside: string } {
  const base = mkdtempSync(path.join(os.tmpdir(), "pid-files-"));
  t.after(() => rmSync(base, { recursive: true, force: true, maxRetries: 5 }));
  const root = path.join(base, "ws");
  const outside = path.join(base, "outside");
  mkdirSync(root);
  mkdirSync(outside);
  mkdirSync(path.join(root, "src"));
  mkdirSync(path.join(root, ".git"));
  writeFileSync(path.join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(path.join(root, "README.md"), "# hi\n");
  writeFileSync(path.join(root, "src", "a.ts"), "export const a = 1;\n");
  writeFileSync(path.join(outside, "secret.txt"), "nope\n");
  return { root: canonicalize(root), outside: canonicalize(outside) };
}

function symlinkOrSkip(target: string, link: string, kind: "file" | "dir"): boolean {
  try {
    symlinkSync(target, link, win ? (kind === "dir" ? "junction" : "file") : undefined);
    return true;
  } catch {
    return false; // Windows without symlink privilege
  }
}

const refusal = (fn: () => unknown, rule?: string) =>
  assert.throws(
    fn,
    (e: unknown) =>
      e instanceof FileError &&
      e.status === 403 &&
      e.code === "outside_workspace" &&
      (!rule || e.extra.rule === rule),
  );

test("the boundary list: every way of leaving the workspace is a 403 that names the rule and not the path", (t) => {
  const { root, outside } = fixture(t);
  refusal(() => stat(root, "../outside/secret.txt"), "traversal");
  refusal(() => stat(root, "src/../../outside/secret.txt"), "traversal");
  refusal(() => stat(root, path.join(outside, "secret.txt")), win ? "drive-relative" : "absolute");
  refusal(() => stat(root, "/etc/passwd"), "absolute");
  refusal(() => stat(root, "//server/share/x"), "unc");
  refusal(() => stat(root, "\\\\server\\share\\x"), "unc");
  refusal(() => stat(root, "C:foo"), "drive-relative");
  refusal(() => stat(root, "src/a\0.ts"), "control-character");
  refusal(() => stat(root, "src/a .ts"), "control-character");
  refusal(() => stat(root, "src/\x1b[31mred"), "control-character");
  refusal(() => stat(root, ""), "empty");
  try {
    stat(root, "../outside/secret.txt");
  } catch (e) {
    assert.ok(!(e as Error).message.includes("outside"), "the message never echoes the path");
  }
  assert.ok(existsSync(path.join(outside, "secret.txt")));
});

test("symlinks: listed as symlinks, never followed out, deleted as links", (t) => {
  const { root, outside } = fixture(t);
  if (!symlinkOrSkip(path.join(outside, "secret.txt"), path.join(root, "leak"), "file"))
    return t.skip("no symlink privilege");
  symlinkSync(path.join(root, "leak"), path.join(root, "chain"));
  symlinkSync(path.join(root, "README.md"), path.join(root, "inside-link"));
  symlinkOrSkip(outside, path.join(root, "outdir"), "dir");
  return (async () => {
    const page = await tree(root, "", { all: true, git: false });
    const leak = page.entries.find((e) => e.name === "leak");
    assert.equal(leak?.kind, "symlink");
    assert.equal(leak?.target, undefined, "an outside target is not revealed");
    assert.equal(page.entries.find((e) => e.name === "inside-link")?.target, "README.md");
    assert.equal(page.entries.find((e) => e.name === "outdir")?.kind, win ? "dir" : "symlink");
    refusal(() => read(root, "leak"), "escapes-root");
    refusal(() => read(root, "chain"), "escapes-root");
    refusal(() => read(root, "outdir/secret.txt"), "escapes-root");
    refusal(() => remove(root, "leak"), "escapes-root");
    // an in-tree link is removable as a link
    remove(root, "inside-link");
    assert.ok(existsSync(path.join(root, "README.md")), "the target survives");
    assert.ok(!existsSync(path.join(root, "inside-link")));
    assert.equal(readFileSync(path.join(outside, "secret.txt"), "utf8"), "nope\n");
  })();
});

test("case-insensitive filesystems: a case-variant path resolves to the same file and stays inside", (t) => {
  const { root } = fixture(t);
  if (posix && process.platform !== "darwin") return t.skip("case-sensitive filesystem");
  const meta = stat(root, "readme.MD");
  assert.equal(meta.path, "README.md", "canonical case comes back");
  refusal(() => stat(root, "SRC/../../outside/secret.txt"), "traversal");
});

test("reads: sniffing, ETag, size cap with Range", (t) => {
  const { root } = fixture(t);
  const big = Buffer.alloc(5 * 1024 * 1024, 0x41);
  writeFileSync(path.join(root, "big.bin"), big);
  writeFileSync(path.join(root, "img.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]));
  assert.equal(stat(root, "img.png").contentType, "application/octet-stream");
  assert.equal(stat(root, "README.md").contentType, "text/markdown; charset=utf-8");
  assert.equal(stat(root, "src/a.ts").contentType, "text/typescript; charset=utf-8");
  const e1 = stat(root, "README.md").etag;
  assert.match(e1, /^"[0-9a-z]+-[0-9a-z]+-[0-9a-f]{32}"$/);
  assert.equal(stat(root, "README.md").etag, e1, "stable across reads");

  assert.throws(
    () => read(root, "big.bin", { maxBytes: 4 * 1024 * 1024 }),
    (e: unknown) => e instanceof FileError && e.status === 413 && e.extra.size === big.length,
  );
  const part = read(root, "big.bin", { maxBytes: 4 * 1024 * 1024, range: { start: 10, end: 20 } });
  assert.equal(part.bytes.length, 10);
  assert.deepEqual(part.range, { start: 10, end: 20, total: big.length });
  assert.throws(
    () => read(root, "big.bin", { range: { start: 5, end: 5 } }),
    (e: unknown) => e instanceof FileError && e.status === 416,
  );
  assert.throws(
    () => stat(root, "src"),
    (e: unknown) => e instanceof FileError && e.status === 409,
  );
  assert.throws(
    () => stat(root, "nope.txt"),
    (e: unknown) => e instanceof FileError && e.status === 404,
  );
});

test("writes: If-Match is required to replace, a stale ETag leaves the file untouched, modes survive, creates are atomic", (t) => {
  const { root } = fixture(t);
  const meta = write(root, "new/deep/file.txt", Buffer.from("one\r\n"), { parents: true });
  assert.equal(
    readFileSync(path.join(root, "new", "deep", "file.txt"), "utf8"),
    "one\r\n",
    "byte for byte, CRLF kept",
  );
  assert.throws(
    () => write(root, "nope/x.txt", Buffer.from("x"), { parents: false, ifNoneMatch: "*" }),
    (e: unknown) => e instanceof FileError && e.status === 404,
    "parent missing without parents",
  );
  assert.throws(
    () => write(root, "new/deep/file.txt", Buffer.from("two")),
    (e: unknown) => e instanceof FileError && e.status === 428,
  );
  assert.throws(
    () => write(root, "new/deep/file.txt", Buffer.from("two"), { ifMatch: '"stale"' }),
    (e: unknown) => e instanceof FileError && e.status === 412 && typeof e.extra.etag === "string",
  );
  assert.equal(
    readFileSync(path.join(root, "new", "deep", "file.txt"), "utf8"),
    "one\r\n",
    "untouched after 412",
  );
  assert.throws(
    () => write(root, "new/deep/file.txt", Buffer.from("two"), { ifNoneMatch: "*" }),
    (e: unknown) => e instanceof FileError && e.status === 412 && e.code === "exists",
  );
  const meta2 = write(root, "new/deep/file.txt", Buffer.from("two"), { ifMatch: meta.etag });
  assert.notEqual(meta2.etag, meta.etag);
  assert.equal(readFileSync(path.join(root, "new", "deep", "file.txt"), "utf8"), "two");
  write(root, "new/deep/file.txt", Buffer.from("three"), { force: true });
  assert.throws(
    () => write(root, "src", Buffer.from("x"), { force: true }),
    (e: unknown) => e instanceof FileError && e.status === 409,
  );
  refusal(() => write(root, "../escape.txt", Buffer.from("x")), "traversal");
  assert.equal(
    [...new Set(readdirNames(root))].filter((n) => n.includes(".tmp")).length,
    0,
    "no temp files left behind",
  );

  if (posix) {
    const exe = path.join(root, "run.sh");
    writeFileSync(exe, "#!/bin/sh\n");
    chmodSync(exe, 0o755);
    write(root, "run.sh", Buffer.from("#!/bin/sh\necho hi\n"), { ifMatch: stat(root, "run.sh").etag });
    assert.equal(statSync(exe).mode & 0o777, 0o755, "an executable stays executable");
  }
});

function readdirNames(dir: string): string[] {
  return readdirSync(dir);
}

test("delete and move: directories need recursive, root and .git are protected, moves stay inside", (t) => {
  const { root, outside } = fixture(t);
  assert.throws(
    () => remove(root, "src"),
    (e: unknown) => e instanceof FileError && e.status === 409 && e.code === "is_directory",
  );
  assert.ok(existsSync(path.join(root, "src", "a.ts")));
  for (const p of [".", ".git", ".git/HEAD", "./.git"]) {
    assert.throws(
      () => remove(root, p, { recursive: true }),
      (e: unknown) => e instanceof FileError && e.status === 403 && e.code === "protected",
      p,
    );
  }
  assert.ok(existsSync(path.join(root, ".git", "HEAD")));
  const etag = stat(root, "README.md").etag;
  assert.throws(
    () => remove(root, "README.md", { ifMatch: '"stale"' }),
    (e: unknown) => e instanceof FileError && e.status === 412,
  );
  remove(root, "README.md", { ifMatch: etag });
  assert.ok(!existsSync(path.join(root, "README.md")));
  remove(root, "src", { recursive: true });
  assert.ok(!existsSync(path.join(root, "src")));
  assert.throws(
    () => remove(root, "src"),
    (e: unknown) => e instanceof FileError && e.status === 404,
  );

  mkdir(root, "lib");
  assert.throws(
    () => mkdir(root, "lib"),
    (e: unknown) => e instanceof FileError && e.status === 409,
  );
  write(root, "lib/x.txt", Buffer.from("x"));
  refusal(() => move(root, "lib/x.txt", "../outside/x.txt"), "traversal");
  refusal(() => move(root, path.join(outside, "secret.txt"), "lib/s.txt"));
  assert.throws(
    () => move(root, ".", "lib/root"),
    (e: unknown) => e instanceof FileError && e.code === "protected",
  );
  move(root, "lib/x.txt", "lib/y.txt");
  assert.ok(existsSync(path.join(root, "lib", "y.txt")));
  write(root, "lib/z.txt", Buffer.from("z"));
  assert.throws(
    () => move(root, "lib/y.txt", "lib/z.txt"),
    (e: unknown) => e instanceof FileError && e.status === 409,
  );
  move(root, "lib/y.txt", "lib/z.txt", { overwrite: true });
  assert.equal(readFileSync(path.join(root, "lib", "z.txt"), "utf8"), "x");
  assert.ok(existsSync(path.join(outside, "secret.txt")));
});

test("tree: pages by cursor, caps depth, hides .git and ignored entries unless all=1", {
  skip: !gitAvailable(),
}, async (t) => {
  const { root } = fixture(t);
  rmSync(path.join(root, ".git"), { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: root });
  writeFileSync(path.join(root, ".gitignore"), "ignored.txt\nnode_modules/\n");
  writeFileSync(path.join(root, "ignored.txt"), "x");
  mkdirSync(path.join(root, "node_modules"));
  mkdirSync(path.join(root, "many"));
  for (let i = 0; i < 1200; i++)
    writeFileSync(path.join(root, "many", `f${String(i).padStart(4, "0")}.txt`), "");
  mkdirSync(path.join(root, "src", "deep", "deeper", "deepest", "bottom"), { recursive: true });

  const top = await tree(root, "");
  const names = top.entries.map((e) => e.name);
  assert.ok(!names.includes(".git"));
  assert.ok(!names.includes("ignored.txt"));
  assert.ok(!names.includes("node_modules"));
  assert.ok(names.includes("src"));
  const all = await tree(root, ".", { all: true });
  assert.ok(all.entries.some((e) => e.name === ".git" && e.kind === "dir"));
  assert.equal(all.entries.find((e) => e.name === "ignored.txt")?.ignored, true);
  assert.equal(all.entries.find((e) => e.name === "README.md")?.ignored, false);

  const p1 = await tree(root, "many", { limit: 500 });
  assert.equal(p1.entries.length, 500);
  assert.equal(p1.truncated, true);
  assert.equal(p1.nextCursor, "f0499.txt");
  const p2 = await tree(root, "many", { limit: 500, cursor: p1.nextCursor });
  assert.equal(p2.entries[0]?.name, "f0500.txt");
  const p3 = await tree(root, "many", { limit: 500, cursor: p2.nextCursor });
  assert.equal(p3.entries.length, 200);
  assert.equal(p3.truncated, false);
  assert.equal(p3.nextCursor, undefined);

  const deep = await tree(root, "src", { depth: 99 });
  const d1 = deep.entries.find((e) => e.name === "deep");
  const d2 = d1?.children?.find((e) => e.name === "deeper");
  const d3 = d2?.children?.find((e) => e.name === "deepest");
  assert.ok(d1 && d2 && d3, "depth is capped at 4, not 1");
  const d4 = d3.children?.find((e) => e.name === "bottom");
  assert.ok(d4, "four levels are listed");
  assert.equal(d4.children, undefined, "and it stops there");
  assert.equal(deep.path, "src");
  await assert.rejects(tree(root, "README.md"), (e: unknown) => e instanceof FileError && e.status === 409);
  await assert.rejects(tree(root, "missing"), (e: unknown) => e instanceof FileError && e.status === 404);
  await assert.rejects(tree(root, "../"), (e: unknown) => e instanceof FileError && e.status === 403);
});
