// `terminals`: PTY spawn and kill, the server-side screen model, and the terminal set. The only
// module allowed to import node-pty (spec §2.2).

export type { CreateTerminalParams, Publish, TerminalManagerOptions } from "./manager.ts";
export {
  TerminalCapError,
  TerminalManager,
  TerminalNotFoundError,
  TerminalsDisabledError,
  TerminalsUnavailableError,
} from "./manager.ts";
export type { PtyBackend, PtyLoader, PtyModule, PtyProcess, PtyStatus } from "./pty.ts";
export { defaultPtyLoader, loadPty, PTY_CANDIDATES, resetPtyCache } from "./pty.ts";
export type { Screen, ScreenOptions } from "./screen.ts";
export { createScreen } from "./screen.ts";
export type { OutputSink, TerminalExit, TerminalInfo, TerminalSpawn, TerminalStatus } from "./terminal.ts";
export { Terminal } from "./terminal.ts";
