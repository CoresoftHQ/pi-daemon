// `runners`: spawning and supervising `pi --mode rpc`. The only module that knows pi exists.

export type { JsonlSplitter } from "./jsonl.ts";
export { createJsonlSplitter, encodeJsonl } from "./jsonl.ts";
export type {
  ExtensionUiRequest,
  ExtensionUiResponse,
  RpcCommand,
  RpcCommandType,
  RpcEvent,
  RpcModel,
  RpcResponse,
  RpcState,
  ThinkingLevel,
  UiMethod,
} from "./rpc.ts";
export { BLOCKING_UI_METHODS } from "./rpc.ts";
export type { RunnerEvents, RunnerExit, RunnerSpawnOptions, RunnerState } from "./runner.ts";
export { buildArgs, PiNotFoundError, Runner, RunnerExitedError } from "./runner.ts";
