// `os`: every OS-specific primitive, and the only place allowed to branch on platform.
// Everything else asks this module for behaviour, never for the platform name.

export type { CanonicalPath, ResolveInsideFailure, ResolveInsideResult, SegmentProblem } from "./canon.ts";
export {
  canonicalize,
  exceedsMaxPath,
  isDirectory,
  isInside,
  resolveInside,
  toCanonicalPath,
  validateSegment,
  WINDOWS_MAX_PATH,
} from "./canon.ts";
export type { AtomicWriteOptions, DirectoryWatcher, WatchEvent, WatchOptions } from "./fsx.ts";
export {
  ensureDir,
  fileExists,
  readJsonSync,
  watchDirectory,
  writeFileAtomicSync,
  writeJsonAtomicSync,
} from "./fsx.ts";
export { connectLocal, listenLocal, localEndpointPath } from "./ipc.ts";
export type { AcquireLockOptions, Lock, LockInfo } from "./lock.ts";
export { acquireLock, LockHeldError } from "./lock.ts";
export type { LogFields, Logger, LoggerOptions, LogLevel } from "./log.ts";
export { createLogger, redactSecrets } from "./log.ts";
export type { AppDirs, PathsEnv, Platform } from "./paths.ts";
export { appDirs, homeDir, piAgentDir, piSessionsDir, platform, tmpDir, userName } from "./paths.ts";
export type { ServiceDefinition, ServiceManager, ServiceState, ServiceStatus } from "./service/index.ts";
export { serviceManager } from "./service/index.ts";
export type { Launcher, ShellChoice, SpawnArgvOptions } from "./spawn.ts";
export { findOnPath, killTree, pidAlive, resolvePiLauncher, spawnArgv, userShell } from "./spawn.ts";
