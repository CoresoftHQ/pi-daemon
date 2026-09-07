// `cli`: the composition root and the operator's commands. The only module that may import
// every other one (spec §2.2).

export type { BindMode, DaemonConfig, TlsSetting } from "./config.ts";
export {
  ConfigError,
  configFile,
  DEFAULT_CONFIG,
  getPath,
  loadConfig,
  mergeConfig,
  parseConfigValue,
  readConfigDocument,
  setPath,
  validateConfig,
  writeConfigDocument,
} from "./config.ts";
export type { ControlClientOptions, ControlHandler, ControlServer } from "./control.ts";
export {
  CONTROL_NAME,
  ControlUnreachableError,
  controlEndpoint,
  controlRequest,
  startControlServer,
} from "./control.ts";
export type { RunningDaemon, StartOptions, StopReason } from "./daemon.ts";
export { BindError, SERVICE_NAME, startDaemon } from "./daemon.ts";
export type { DoctorProbes, Finding, Verdict } from "./doctor.ts";
export { defaultProbes, formatFindings, MIN_NODE, runDoctor } from "./doctor.ts";
export type { CliIo } from "./main.ts";
export { runCli } from "./main.ts";
export { renderQr } from "./qr.ts";
