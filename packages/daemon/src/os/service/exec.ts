import { spawnArgv } from "../spawn.ts";

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Run a system tool with argv, capture output, never throw on non-zero exit. */
export function exec(command: string, args: string[], env?: NodeJS.ProcessEnv): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawnArgv(command, args, { env: env ?? process.env });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    child.on("error", (err) => resolve({ code: null, stdout, stderr: `${stderr}${err.message}` }));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

export function shellQuote(arg: string): string {
  return /^[A-Za-z0-9_\-./=:@%+]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

export function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
