// JSONL framing for pi's RPC mode. Split on "\n" only, tolerate a trailing "\r", and never use
// readline — it also splits on U+2028 / U+2029, which are legal inside JSON strings. A streaming
// UTF-8 decoder keeps a multi-byte character split across chunks intact.

export interface JsonlSplitter {
  push(chunk: Uint8Array): void;
  /** Call when the byte stream closes, to detect a truncated trailing record. */
  end(): void;
}

export function createJsonlSplitter(
  onRecord: (record: unknown) => void,
  onError: (error: Error, line: string) => void = () => {},
): JsonlSplitter {
  const decoder = new TextDecoder("utf-8");
  let pending = "";
  return {
    push(chunk) {
      pending += decoder.decode(chunk, { stream: true });
      let nl = pending.indexOf("\n");
      while (nl !== -1) {
        let line = pending.slice(0, nl);
        pending = pending.slice(nl + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (line.length > 0) {
          let record: unknown;
          try {
            record = JSON.parse(line);
          } catch (err) {
            onError(err as Error, line);
            nl = pending.indexOf("\n");
            continue;
          }
          onRecord(record);
        }
        nl = pending.indexOf("\n");
      }
    },
    end() {
      pending += decoder.decode();
      if (pending.length > 0) onError(new Error("truncated trailing record"), pending);
      pending = "";
    },
  };
}

export function encodeJsonl(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}
