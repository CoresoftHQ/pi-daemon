// Linux: a systemd *user* unit, plus `loginctl enable-linger` so it survives logout on a
// headless box (spec §9).

import { mkdirSync, unlinkSync } from "node:fs";
import path from "node:path";
import { writeFileAtomicSync } from "../fsx.ts";
import { exec, shellQuote } from "./exec.ts";
import type { ServiceDefinition, ServiceManager, ServiceStatus } from "./types.ts";

export class SystemdUserServiceManager implements ServiceManager {
  readonly kind = "systemd-user" as const;
  readonly #unitDir: string;

  constructor(configHome: string) {
    this.#unitDir = path.join(configHome, "systemd", "user");
  }

  unitPath(name: string): string {
    return path.join(this.#unitDir, `${name}.service`);
  }

  render(def: ServiceDefinition): string {
    const envLines = Object.entries(def.env ?? {}).map(([k, v]) => `Environment=${shellQuote(`${k}=${v}`)}`);
    return [
      "[Unit]",
      `Description=${def.description}`,
      "After=network.target",
      "",
      "[Service]",
      "Type=simple",
      `ExecStart=${def.argv.map(shellQuote).join(" ")}`,
      ...(def.cwd ? [`WorkingDirectory=${def.cwd}`] : []),
      ...envLines,
      "Restart=on-failure",
      "RestartSec=2",
      "KillMode=control-group",
      "",
      "[Install]",
      "WantedBy=default.target",
      "",
    ].join("\n");
  }

  async install(def: ServiceDefinition): Promise<void> {
    mkdirSync(this.#unitDir, { recursive: true });
    writeFileAtomicSync(this.unitPath(def.name), this.render(def), { mode: 0o644 });
    const reload = await exec("systemctl", ["--user", "daemon-reload"]);
    if (reload.code !== 0) throw new Error(`systemctl --user daemon-reload failed: ${reload.stderr.trim()}`);
    const enable = await exec("systemctl", ["--user", "enable", "--now", `${def.name}.service`]);
    if (enable.code !== 0) throw new Error(`systemctl --user enable failed: ${enable.stderr.trim()}`);
    if (def.linger) await exec("loginctl", ["enable-linger"]);
  }

  async uninstall(name: string): Promise<void> {
    await exec("systemctl", ["--user", "disable", "--now", `${name}.service`]);
    try {
      unlinkSync(this.unitPath(name));
    } catch {
      /* not installed */
    }
    await exec("systemctl", ["--user", "daemon-reload"]);
  }

  async start(name: string): Promise<void> {
    const r = await exec("systemctl", ["--user", "start", `${name}.service`]);
    if (r.code !== 0) throw new Error(`systemctl --user start failed: ${r.stderr.trim()}`);
  }

  async stop(name: string): Promise<void> {
    const r = await exec("systemctl", ["--user", "stop", `${name}.service`]);
    if (r.code !== 0) throw new Error(`systemctl --user stop failed: ${r.stderr.trim()}`);
  }

  async status(name: string): Promise<ServiceStatus> {
    const r = await exec("systemctl", ["--user", "is-active", `${name}.service`]);
    const out = r.stdout.trim();
    if (r.code === null) return { state: "unknown", installed: false, detail: r.stderr.trim() };
    if (out === "active") return { state: "running", installed: true };
    const enabled = await exec("systemctl", ["--user", "is-enabled", `${name}.service`]);
    const installed = enabled.code === 0 || /disabled|enabled/.test(enabled.stdout);
    return { state: installed ? "stopped" : "not-installed", installed, detail: out };
  }
}
