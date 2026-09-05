// Windows: a scheduled task at the current user's logon, needing no admin (spec §9).
//
// `schtasks.exe /SC ONLOGON` is denied for a standard user even with /RU and /IT, but the
// ScheduledTasks PowerShell module registers a per-user AtLogOn trigger with a Limited principal
// without elevation (verified in M1). Scripts go through -EncodedCommand so no argument ever
// meets a shell's quoting rules. A boot-time Windows Service needs admin and is not provided here.

import { exec } from "./exec.ts";
import type { ServiceDefinition, ServiceManager, ServiceStatus } from "./types.ts";

/** PowerShell single-quoted literal. */
function ps(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/** Windows command-line quoting for one argument of a task action. */
function winArg(arg: string): string {
  return /[\s"]/.test(arg) ? `"${arg.replace(/(\\*)"/g, '$1$1\\"')}"` : arg;
}

async function runPowerShell(
  script: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  return exec("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-EncodedCommand",
    encoded,
  ]);
}

export class WindowsTaskServiceManager implements ServiceManager {
  readonly kind = "windows-task" as const;

  /** The registration script. Also what `--dry-run` prints. */
  render(def: ServiceDefinition): string {
    const [exe, ...rest] = def.argv;
    if (!exe) throw new Error("service argv is empty");
    const env = Object.entries(def.env ?? {});
    // With environment variables, the action becomes a hidden PowerShell wrapper that sets them.
    const execute = env.length ? "powershell.exe" : exe;
    const argument = env.length
      ? [
          "-NoProfile",
          "-NonInteractive",
          "-WindowStyle",
          "Hidden",
          "-Command",
          `& { ${env.map(([k, v]) => `$env:${k} = ${ps(v)};`).join(" ")} & ${ps(exe)} ${rest.map(ps).join(" ")} }`,
        ]
          .map(winArg)
          .join(" ")
      : rest.map(winArg).join(" ");
    return [
      "$ErrorActionPreference = 'Stop'",
      `$me = "$env:USERDOMAIN\\$env:USERNAME"`,
      `$action = New-ScheduledTaskAction -Execute ${ps(execute)} -Argument ${ps(argument)}${def.cwd ? ` -WorkingDirectory ${ps(def.cwd)}` : ""}`,
      "$trigger = New-ScheduledTaskTrigger -AtLogOn -User $me",
      "$principal = New-ScheduledTaskPrincipal -UserId $me -LogonType Interactive -RunLevel Limited",
      "$settings = New-ScheduledTaskSettingsSet -Hidden -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Days 3650) -MultipleInstances IgnoreNew",
      `Register-ScheduledTask -TaskName ${ps(def.name)} -Description ${ps(def.description)} -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null`,
      `Start-ScheduledTask -TaskName ${ps(def.name)}`,
      "",
    ].join("\n");
  }

  async install(def: ServiceDefinition): Promise<void> {
    if (def.bootTime)
      throw new Error("boot-time start needs a Windows Service, which requires admin; not provided");
    const r = await runPowerShell(this.render(def));
    if (r.code !== 0) throw new Error(`Register-ScheduledTask failed: ${(r.stderr || r.stdout).trim()}`);
  }

  async uninstall(name: string): Promise<void> {
    await runPowerShell(
      [
        `Stop-ScheduledTask -TaskName ${ps(name)} -ErrorAction SilentlyContinue`,
        `Unregister-ScheduledTask -TaskName ${ps(name)} -Confirm:$false -ErrorAction SilentlyContinue`,
      ].join("\n"),
    );
  }

  async start(name: string): Promise<void> {
    const r = await runPowerShell(
      `$ErrorActionPreference = 'Stop'\nStart-ScheduledTask -TaskName ${ps(name)}`,
    );
    if (r.code !== 0) throw new Error(`Start-ScheduledTask failed: ${(r.stderr || r.stdout).trim()}`);
  }

  async stop(name: string): Promise<void> {
    const r = await runPowerShell(
      `$ErrorActionPreference = 'Stop'\nStop-ScheduledTask -TaskName ${ps(name)}`,
    );
    if (r.code !== 0) throw new Error(`Stop-ScheduledTask failed: ${(r.stderr || r.stdout).trim()}`);
  }

  async status(name: string): Promise<ServiceStatus> {
    const r = await runPowerShell(
      [
        `try { $t = Get-ScheduledTask -TaskName ${ps(name)} -ErrorAction Stop; [pscustomobject]@{ installed = $true; state = [string]$t.State } | ConvertTo-Json -Compress }`,
        `catch { [pscustomobject]@{ installed = $false; state = 'not-installed' } | ConvertTo-Json -Compress }`,
      ].join("\n"),
    );
    if (r.code === null) return { state: "unknown", installed: false, detail: r.stderr.trim() };
    let parsed: { installed?: boolean; state?: string } = {};
    try {
      parsed = JSON.parse(r.stdout.trim().split("\n").at(-1) ?? "{}") as typeof parsed;
    } catch {
      return { state: "unknown", installed: false, detail: (r.stderr || r.stdout).trim() };
    }
    if (!parsed.installed) return { state: "not-installed", installed: false };
    const s = (parsed.state ?? "").toLowerCase();
    return {
      state:
        s === "running"
          ? "running"
          : s === "ready" || s === "disabled" || s === "queued"
            ? "stopped"
            : "unknown",
      installed: true,
      detail: parsed.state,
    };
  }
}
