// Spawns `pi --mode rpc` and speaks its JSONL protocol.
//
// One Runner = one pi process = one live session. Commands are correlated by
// id; events are emitted as they arrive; extension UI requests are surfaced
// separately so a caller can relay them and answer.

import { spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import path from "node:path";
import { createJsonlSplitter } from "./jsonl.mjs";

let resolvedPi;

/**
 * Resolve how to start pi. On Windows the global `pi` on PATH is an npm .cmd
 * shim, which Node refuses to spawn without a shell; we run the CLI entry with
 * our own node instead. PI_BIN=<path to cli.js> overrides.
 */
export function resolvePi() {
  if (resolvedPi) return resolvedPi;
  if (process.env.PI_BIN) {
    resolvedPi = { command: process.execPath, prefix: [process.env.PI_BIN] };
    return resolvedPi;
  }
  const root = spawnSync("npm root -g", { encoding: "utf8", shell: true }).stdout.trim();
  const cli = path.join(root, "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");
  if (existsSync(cli)) {
    resolvedPi = { command: process.execPath, prefix: [cli] };
    return resolvedPi;
  }
  resolvedPi = { command: "pi", prefix: [] };
  return resolvedPi;
}

export class Runner extends EventEmitter {
  #proc;
  #pending = new Map(); // id -> { resolve, reject }
  #seq = 0;
  #exited = false;
  stderr = "";

  constructor({ cwd, args = [], env = process.env }) {
    super();
    this.cwd = cwd;
    this.args = args;
    this.env = env;
  }

  get pid() {
    return this.#proc?.pid;
  }

  get exited() {
    return this.#exited;
  }

  start() {
    const { command, prefix } = resolvePi();
    this.#proc = spawn(command, [...prefix, "--mode", "rpc", ...this.args], {
      cwd: this.cwd,
      env: this.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const splitter = createJsonlSplitter(
      (record) => this.#onRecord(record),
      (err, line) => this.emit("protocol_error", err, line),
    );
    this.#proc.stdout.on("data", (chunk) => splitter.push(chunk));
    this.#proc.stderr.on("data", (chunk) => {
      this.stderr += chunk.toString();
      this.emit("stderr", chunk.toString());
    });
    this.#proc.on("exit", (code, signal) => {
      this.#exited = true;
      splitter.end();
      for (const [, p] of this.#pending) p.reject(new Error(`runner exited (${code ?? signal}) before response`));
      this.#pending.clear();
      this.emit("exit", { code, signal });
    });
    return this;
  }

  #onRecord(record) {
    if (record.type === "response" && record.id && this.#pending.has(record.id)) {
      const p = this.#pending.get(record.id);
      this.#pending.delete(record.id);
      p.resolve(record);
      return;
    }
    if (record.type === "extension_ui_request") {
      this.emit("ui_request", record);
      return;
    }
    this.emit("event", record);
  }

  /** Returns false if the runner is gone; a dead runner is a normal race, not an exception. */
  #write(obj) {
    if (this.#exited || !this.#proc.stdin.writable) return false;
    this.#proc.stdin.write(JSON.stringify(obj) + "\n");
    return true;
  }

  /** Send a command and await its correlated response. */
  send(command) {
    const id = `c${++this.#seq}`;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      if (!this.#write({ id, ...command })) {
        this.#pending.delete(id);
        reject(new Error("runner has exited"));
      }
    });
  }

  /**
   * Answer an extension_ui_request. payload: { value } | { confirmed } | { cancelled: true }
   * Returns false when the runner has already exited (the dialog died with it).
   */
  respondUi(id, payload) {
    return this.#write({ type: "extension_ui_response", id, ...payload });
  }

  /** Wait until the runner is idle: agent_settled after the next agent_start, or immediately if idle. */
  waitForEvent(type, timeoutMs = 120_000) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.off("event", h);
        reject(new Error(`timed out waiting for ${type}`));
      }, timeoutMs);
      const h = (e) => {
        if (e.type === type) {
          clearTimeout(t);
          this.off("event", h);
          resolve(e);
        }
      };
      this.on("event", h);
    });
  }

  /** Tree-kill. Windows has no process groups; taskkill /T walks the tree. */
  kill() {
    if (!this.#proc || this.#exited) return;
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/PID", String(this.#proc.pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      try {
        process.kill(-this.#proc.pid, "SIGKILL");
      } catch {
        this.#proc.kill("SIGKILL");
      }
    }
  }
}
