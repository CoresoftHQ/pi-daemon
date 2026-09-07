// The daemon keeps the screen (spec §5.5): a headless emulator sized to the terminal, with a
// bounded scrollback, that serialises to VT sequences any client emulator can replay. The
// interface is what the rest of the module sees; `@xterm/headless` is the v1 implementation,
// and libghostty-vt is a one-file swap when it has Windows prebuilds.

import { createRequire } from "node:module";

export interface Screen {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  /** The screen and scrollback as VT sequences, after every pending write has been parsed. */
  serialize(): Promise<string>;
  onTitle(listener: (title: string) => void): () => void;
  readonly cols: number;
  readonly rows: number;
  dispose(): void;
}

export interface ScreenOptions {
  cols: number;
  rows: number;
  scrollback: number;
}

const require = createRequire(import.meta.url);

interface XtermTerminal {
  cols: number;
  rows: number;
  write(data: string, callback?: () => void): void;
  resize(cols: number, rows: number): void;
  loadAddon(addon: unknown): void;
  onTitleChange(listener: (title: string) => void): { dispose(): void };
  dispose(): void;
}
interface XtermSerializeAddon {
  serialize(options?: { scrollback?: number }): string;
}
interface XtermHeadlessModule {
  Terminal: new (options: {
    cols: number;
    rows: number;
    scrollback: number;
    allowProposedApi: boolean;
  }) => XtermTerminal;
}
interface XtermSerializeModule {
  SerializeAddon: new () => XtermSerializeAddon;
}

let mods: { headless: XtermHeadlessModule; serialize: XtermSerializeModule } | undefined;
function xterm() {
  if (!mods) {
    mods = {
      headless: require("@xterm/headless") as XtermHeadlessModule,
      serialize: require("@xterm/addon-serialize") as XtermSerializeModule,
    };
  }
  return mods;
}

export function createScreen(options: ScreenOptions): Screen {
  const { headless, serialize } = xterm();
  const term = new headless.Terminal({
    cols: options.cols,
    rows: options.rows,
    scrollback: options.scrollback,
    allowProposedApi: true,
  });
  const ser = new serialize.SerializeAddon();
  term.loadAddon(ser);
  return {
    get cols() {
      return term.cols;
    },
    get rows() {
      return term.rows;
    },
    write(data) {
      term.write(data);
    },
    resize(cols, rows) {
      term.resize(cols, rows);
    },
    serialize() {
      // xterm parses asynchronously; an empty write's callback runs after everything before it.
      return new Promise((resolve) =>
        term.write("", () => resolve(ser.serialize({ scrollback: options.scrollback }))),
      );
    },
    onTitle(listener) {
      const d = term.onTitleChange(listener);
      return () => d.dispose();
    },
    dispose() {
      term.dispose();
    },
  };
}
