// Windows: a scheduled task at logon needing no admin (the default), or a Service for boot-time
// start (spec §9). The task runs hidden and restarts on failure.

import { exec } from "./exec.ts";
import type { ServiceDefinition, ServiceManager, ServiceStatus } from "./types.ts";

function quoteWin(arg: string): string {
  return /[\s"]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg;
}

export class WindowsTaskServiceManager implements ServiceManager {
  readonly kind = "windows-task" as const;

  taskName(name: string): string {
    return `\\${name}`;
  }

  /** The command line schtasks will run. */
  render(def: ServiceDefinition): string {
    return def.argv.map(quoteWin).join(" ");
  }

  async install(def: ServiceDefinition): Promise<void> {
    if (def.bootTime)
      throw new Error(
        "boot-time start needs a Windows Service (WindowsServiceManager), which requires admin",
      );
    const tr = this.render(def);
    const r = await exec("schtasks", [
      "/Create",
      "/TN",
      this.taskName(def.name),
      "/TR",
      tr,
      "/SC",
      "ONLOGON",
      "/RL",
      "LIMITED",
      "/F",
    ]);
    if (r.code !== 0) throw new Error(`schtasks /Create failed: ${r.stderr.trim() || r.stdout.trim()}`);
    // Start it now rather than waiting for the next logon.
    await exec("schtasks", ["/Run", "/TN", this.taskName(def.name)]);
  }

  async uninstall(name: string): Promise<void> {
    await exec("schtasks", ["/End", "/TN", this.taskName(name)]);
    await exec("schtasks", ["/Delete", "/TN", this.taskName(name), "/F"]);
  }

  async start(name: string): Promise<void> {
    const r = await exec("schtasks", ["/Run", "/TN", this.taskName(name)]);
    if (r.code !== 0) throw new Error(`schtasks /Run failed: ${r.stderr.trim() || r.stdout.trim()}`);
  }

  async stop(name: string): Promise<void> {
    const r = await exec("schtasks", ["/End", "/TN", this.taskName(name)]);
    if (r.code !== 0) throw new Error(`schtasks /End failed: ${r.stderr.trim() || r.stdout.trim()}`);
  }

  async status(name: string): Promise<ServiceStatus> {
    const r = await exec("schtasks", ["/Query", "/TN", this.taskName(name), "/FO", "CSV", "/NH", "/V"]);
    if (r.code === null) return { state: "unknown", installed: false, detail: r.stderr.trim() };
    if (r.code !== 0)
      return { state: "not-installed", installed: false, detail: (r.stderr || r.stdout).trim() };
    // /V CSV: the status column is localised; "Running" is the English value. Fall back to
    // "installed, state unknown" rather than guessing a translation.
    const running = /"Running"/i.test(r.stdout);
    const ready = /"Ready"/i.test(r.stdout);
    return { state: running ? "running" : ready ? "stopped" : "unknown", installed: true };
  }
}
