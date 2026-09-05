import assert from "node:assert/strict";
import { test } from "node:test";
import { createJsonlSplitter, encodeJsonl } from "./jsonl.ts";

function collect() {
  const records: unknown[] = [];
  const errors: string[] = [];
  const s = createJsonlSplitter(
    (r) => records.push(r),
    (_e, line) => errors.push(line),
  );
  return { s, records, errors };
}

test("splits on LF only and tolerates CRLF", () => {
  const { s, records } = collect();
  s.push(Buffer.from('{"a":1}\r\n{"b":2}\n'));
  assert.deepEqual(records, [{ a: 1 }, { b: 2 }]);
});

test("U+2028 and U+2029 inside a string do not split a record", () => {
  const { s, records, errors } = collect();
  const value = { text: "line sep end" };
  s.push(Buffer.from(encodeJsonl(value)));
  assert.deepEqual(records, [value]);
  assert.equal(errors.length, 0);
});

test("arbitrary fragmentation, including inside a multi-byte character", () => {
  const { s, records } = collect();
  const bytes = Buffer.from(encodeJsonl({ s: "héllo → 世界" }) + encodeJsonl({ n: 2 }));
  for (let i = 0; i < bytes.length; i++) s.push(bytes.subarray(i, i + 1));
  assert.deepEqual(records, [{ s: "héllo → 世界" }, { n: 2 }]);
});

test("coalesced chunks and blank lines", () => {
  const { s, records } = collect();
  s.push(Buffer.from('\n\n{"a":1}\n\n{"b":2}\n{"c":3}\n'));
  assert.deepEqual(records, [{ a: 1 }, { b: 2 }, { c: 3 }]);
});

test("a malformed line is reported and skipped; the stream continues", () => {
  const { s, records, errors } = collect();
  s.push(Buffer.from('{"a":1}\nnot json\n{"b":2}\n'));
  assert.deepEqual(records, [{ a: 1 }, { b: 2 }]);
  assert.deepEqual(errors, ["not json"]);
});

test("end() reports a truncated trailing record", () => {
  const { s, records, errors } = collect();
  s.push(Buffer.from('{"a":1}\n{"partial":'));
  s.end();
  assert.deepEqual(records, [{ a: 1 }]);
  assert.deepEqual(errors, ['{"partial":']);
});
