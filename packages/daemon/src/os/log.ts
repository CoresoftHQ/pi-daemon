// JSON-line logging with our own rotation, because journald and Console.app are not universal
// (spec §9). Redaction by default, because tool arguments routinely contain secrets (§7.5).

import { appendFileSync, mkdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  child(fields: LogFields): Logger;
}

export interface LoggerOptions {
  /** Log file. Omit for stderr only. */
  file?: string | undefined;
  /** Rotate when the file exceeds this. */
  maxBytes?: number | undefined;
  /** Keep this many rotated files. */
  maxFiles?: number | undefined;
  /** Also write to stderr. */
  stderr?: boolean | undefined;
  level?: LogLevel | undefined;
  /** Runs over fields before writing. Defaults to redactSecrets. */
  redact?: ((fields: LogFields) => LogFields) | undefined;
  now?: (() => number) | undefined;
}

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const SECRET_KEY = /token|secret|password|passwd|authorization|api[-_]?key|cookie|credential/i;

/** Replace the values of secret-looking keys, recursively. Arrays and nested objects included. */
export function redactSecrets(fields: LogFields): LogFields {
  const out: LogFields = {};
  for (const [k, v] of Object.entries(fields)) {
    if (SECRET_KEY.test(k)) out[k] = "[redacted]";
    else if (Array.isArray(v))
      out[k] = v.map((x) => (x && typeof x === "object" ? redactSecrets(x as LogFields) : x));
    else if (v && typeof v === "object" && !(v instanceof Date) && !(v instanceof Error))
      out[k] = redactSecrets(v as LogFields);
    else if (v instanceof Error) out[k] = { name: v.name, message: v.message, stack: v.stack };
    else out[k] = v;
  }
  return out;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const file = options.file;
  const maxBytes = options.maxBytes ?? 5 * 1024 * 1024;
  const maxFiles = options.maxFiles ?? 5;
  const threshold = LEVELS[options.level ?? "info"];
  const redact = options.redact ?? redactSecrets;
  const now = options.now ?? Date.now;
  if (file) mkdirSync(path.dirname(file), { recursive: true });

  const rotate = () => {
    if (!file) return;
    let size = 0;
    try {
      size = statSync(file).size;
    } catch {
      return;
    }
    if (size < maxBytes) return;
    try {
      unlinkSync(`${file}.${maxFiles}`);
    } catch {
      /* none */
    }
    for (let i = maxFiles - 1; i >= 1; i--) {
      try {
        renameSync(`${file}.${i}`, `${file}.${i + 1}`);
      } catch {
        /* none */
      }
    }
    renameSync(file, `${file}.1`);
  };

  const write = (level: LogLevel, msg: string, base: LogFields, fields?: LogFields) => {
    if (LEVELS[level] < threshold) return;
    const line = `${JSON.stringify({ ts: new Date(now()).toISOString(), level, msg, ...redact({ ...base, ...(fields ?? {}) }) })}\n`;
    if (file) {
      rotate();
      appendFileSync(file, line);
    }
    if (options.stderr || !file) process.stderr.write(line);
  };

  const make = (base: LogFields): Logger => ({
    debug: (m, f) => write("debug", m, base, f),
    info: (m, f) => write("info", m, base, f),
    warn: (m, f) => write("warn", m, base, f),
    error: (m, f) => write("error", m, base, f),
    child: (f) => make({ ...base, ...f }),
  });
  return make({});
}
