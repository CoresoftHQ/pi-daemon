// `serve`: the two wire encodings and the event stream. Holds no state.

export {
  toModelMetadata,
  toProgress,
  toSessionMetadata,
  toSessionSnapshot,
  toTranscriptItem,
} from "./pi-protocol/encode.ts";
export type { PiProtocolServerOptions } from "./pi-protocol/server.ts";
export { PiProtocolServer, ProtocolError } from "./pi-protocol/server.ts";
export type { UpgradeAuthenticator, UpgradeAuthResult, WebSocketListenerOptions } from "./pi-protocol/ws.ts";
export {
  attachWebSocketListener,
  listenLocalEndpoint,
  PI_PROTOCOL_PATH,
  PI_PROTOCOL_SUBPROTOCOL,
  socketDuplex,
  staticTokenAuthenticator,
  wsDuplex,
} from "./pi-protocol/ws.ts";
export type { ByteDuplex } from "./transport.ts";
export { memoryPair } from "./transport.ts";
export type { ResolvedWorkspace, WorkspaceResolver } from "./workspace-resolver.ts";
export { registryResolver, singleRootResolver } from "./workspace-resolver.ts";
