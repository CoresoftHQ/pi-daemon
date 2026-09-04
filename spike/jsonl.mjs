// JSONL splitter for pi's RPC mode.
//
// pi's docs: split on "\n" only, tolerate a trailing "\r", and do NOT use
// Node's readline, which also splits on U+2028 / U+2029 (legal inside JSON
// strings). We decode UTF-8 with a streaming decoder so a multi-byte
// character split across two chunks still decodes correctly.

export function createJsonlSplitter(onRecord, onError = () => {}) {
  const decoder = new TextDecoder("utf-8");
  let pending = "";

  return {
    push(chunk) {
      pending += decoder.decode(chunk, { stream: true });
      let nl;
      while ((nl = pending.indexOf("\n")) !== -1) {
        let line = pending.slice(0, nl);
        pending = pending.slice(nl + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (line.length === 0) continue;
        let record;
        try {
          record = JSON.parse(line);
        } catch (err) {
          onError(err, line);
          continue;
        }
        onRecord(record);
      }
    },
    end() {
      pending += decoder.decode();
      if (pending.length > 0) onError(new Error("truncated trailing record"), pending);
      pending = "";
    },
  };
}
