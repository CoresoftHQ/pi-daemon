import os from "node:os";
import { appDirs, platform } from "../paths.ts";
import { LaunchdServiceManager } from "./launchd.ts";
import { SystemdUserServiceManager } from "./systemd.ts";
import type { ServiceManager } from "./types.ts";
import { WindowsTaskServiceManager } from "./windows.ts";

export type { ServiceDefinition, ServiceManager, ServiceState, ServiceStatus } from "./types.ts";
export { LaunchdServiceManager, SystemdUserServiceManager, WindowsTaskServiceManager };

/** The adapter for this machine. */
export function serviceManager(): ServiceManager {
  switch (platform) {
    case "win32":
      return new WindowsTaskServiceManager();
    case "darwin":
      return new LaunchdServiceManager(os.homedir(), os.userInfo().uid);
    default: {
      const dirs = appDirs();
      // XDG config home is the parent of our config dir.
      return new SystemdUserServiceManager(dirs.config.replace(/[\\/]pi-daemon$/, ""));
    }
  }
}
