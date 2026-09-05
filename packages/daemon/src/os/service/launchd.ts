// macOS: a LaunchAgent with RunAtLoad and KeepAlive (spec §9).

import { mkdirSync, unlinkSync } from "node:fs";
import path from "node:path";
import { writeFileAtomicSync } from "../fsx.ts";
import { exec, xmlEscape } from "./exec.ts";
import type { ServiceDefinition, ServiceManager, ServiceStatus } from "./types.ts";

export class LaunchdServiceManager implements ServiceManager {
  readonly kind = "launchd" as const;
  readonly #agentsDir: string;
  readonly #labelPrefix: string;
  readonly #uid: number;

  constructor(home: string, uid: number, labelPrefix = "com.coresoft") {
    this.#agentsDir = path.join(home, "Library", "LaunchAgents");
    this.#labelPrefix = labelPrefix;
    this.#uid = uid;
  }

  label(name: string): string {
    return `${this.#labelPrefix}.${name}`;
  }

  plistPath(name: string): string {
    return path.join(this.#agentsDir, `${this.label(name)}.plist`);
  }

  render(def: ServiceDefinition): string {
    const args = def.argv.map((a) => `      <string>${xmlEscape(a)}</string>`).join("\n");
    const env = Object.entries(def.env ?? {})
      .map(([k, v]) => `      <key>${xmlEscape(k)}</key>\n      <string>${xmlEscape(v)}</string>`)
      .join("\n");
    return [
      `<?xml version="1.0" encoding="UTF-8"?>`,
      `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
      `<plist version="1.0">`,
      `<dict>`,
      `  <key>Label</key>`,
      `  <string>${xmlEscape(this.label(def.name))}</string>`,
      `  <key>ProgramArguments</key>`,
      `  <array>`,
      args,
      `  </array>`,
      ...(def.cwd ? [`  <key>WorkingDirectory</key>`, `  <string>${xmlEscape(def.cwd)}</string>`] : []),
      ...(env ? [`  <key>EnvironmentVariables</key>`, `  <dict>`, env, `  </dict>`] : []),
      `  <key>RunAtLoad</key>`,
      `  <true/>`,
      `  <key>KeepAlive</key>`,
      `  <true/>`,
      ...(def.logFile
        ? [
            `  <key>StandardOutPath</key>`,
            `  <string>${xmlEscape(def.logFile)}</string>`,
            `  <key>StandardErrorPath</key>`,
            `  <string>${xmlEscape(def.logFile)}</string>`,
          ]
        : []),
      `</dict>`,
      `</plist>`,
      ``,
    ].join("\n");
  }

  async install(def: ServiceDefinition): Promise<void> {
    mkdirSync(this.#agentsDir, { recursive: true });
    const plist = this.plistPath(def.name);
    writeFileAtomicSync(plist, this.render(def), { mode: 0o644 });
    await exec("launchctl", ["bootout", `gui/${this.#uid}/${this.label(def.name)}`]);
    const r = await exec("launchctl", ["bootstrap", `gui/${this.#uid}`, plist]);
    if (r.code !== 0) throw new Error(`launchctl bootstrap failed: ${r.stderr.trim() || r.stdout.trim()}`);
  }

  async uninstall(name: string): Promise<void> {
    await exec("launchctl", ["bootout", `gui/${this.#uid}/${this.label(name)}`]);
    try {
      unlinkSync(this.plistPath(name));
    } catch {
      /* not installed */
    }
  }

  async start(name: string): Promise<void> {
    const r = await exec("launchctl", ["kickstart", `gui/${this.#uid}/${this.label(name)}`]);
    if (r.code !== 0) throw new Error(`launchctl kickstart failed: ${r.stderr.trim()}`);
  }

  async stop(name: string): Promise<void> {
    // KeepAlive would restart it; bootout is the honest "stop" for a LaunchAgent.
    const r = await exec("launchctl", ["bootout", `gui/${this.#uid}/${this.label(name)}`]);
    if (r.code !== 0 && !/No such process|not find/i.test(r.stderr))
      throw new Error(`launchctl bootout failed: ${r.stderr.trim()}`);
  }

  async status(name: string): Promise<ServiceStatus> {
    const r = await exec("launchctl", ["print", `gui/${this.#uid}/${this.label(name)}`]);
    if (r.code === null) return { state: "unknown", installed: false, detail: r.stderr.trim() };
    if (r.code !== 0) {
      let installed = false;
      try {
        installed = (await exec("test", ["-f", this.plistPath(name)])).code === 0;
      } catch {
        /* ignore */
      }
      return { state: installed ? "stopped" : "not-installed", installed };
    }
    const running = /state = running/.test(r.stdout);
    return { state: running ? "running" : "stopped", installed: true };
  }
}
