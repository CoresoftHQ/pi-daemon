// One ServiceManager interface, three adapters (spec §9).

export interface ServiceDefinition {
  /** Stable identifier: unit name, launchd label suffix, scheduled-task name. */
  name: string;
  description: string;
  /** Argv of the daemon: absolute node path plus the CLI entry and its arguments. */
  argv: string[];
  cwd?: string | undefined;
  env?: Record<string, string> | undefined;
  /** Where the service's stdout/stderr go on platforms that need a file. */
  logFile?: string | undefined;
  /** Windows: register as a Service for boot-time start instead of a logon task. Needs admin. */
  bootTime?: boolean | undefined;
  /** Linux: also `loginctl enable-linger` so the user unit survives logout. */
  linger?: boolean | undefined;
}

export type ServiceState = "running" | "stopped" | "not-installed" | "unknown";

export interface ServiceStatus {
  state: ServiceState;
  installed: boolean;
  detail?: string | undefined;
}

export interface ServiceManager {
  readonly kind: "systemd-user" | "launchd" | "windows-task" | "windows-service";
  install(def: ServiceDefinition): Promise<void>;
  uninstall(name: string): Promise<void>;
  start(name: string): Promise<void>;
  stop(name: string): Promise<void>;
  status(name: string): Promise<ServiceStatus>;
  /** Render the unit/plist/task definition without touching the system, for tests and `--dry-run`. */
  render(def: ServiceDefinition): string;
}
