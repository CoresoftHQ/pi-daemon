// @coresoft-hq/pi-daemon-client: pairing, the /v1 API, the event stream, terminal streams.

export type { ClientOptions, FileContent, RequestOptions, WriteFileOptions } from "./client.ts";
export { DaemonError, PiDaemonClient } from "./client.ts";
export type { EventStreamOptions, StreamState } from "./events.ts";
export { EventStream } from "./events.ts";
export type { TerminalConnection, TerminalHandlers } from "./terminal.ts";
export type * from "./types.ts";
