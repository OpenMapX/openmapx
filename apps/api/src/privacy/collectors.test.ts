import { describe, expect, it } from "vitest";
import { jsonl, safeRecord, stableRecordId } from "./collectors.js";

describe("privacy collector utilities", () => {
  it("produces deterministic bounded JSONL without executable content", () => {
    const rows = jsonl([
      { id: "b", value: 2 },
      { id: "a", value: 1 },
    ]);
    expect(rows).toBe('{"id":"a","value":1}\n{"id":"b","value":2}\n');
    expect(stableRecordId("category", { a: 1 })).toHaveLength(64);
    expect(() => safeRecord({ __proto__: "bad" })).not.toThrow();
  });

  it("keeps inert script and shell text as bounded JSON data", () => {
    expect(
      safeRecord({ note: "<script>alert('kept as text')</script>", executable: "#!/bin/sh" }),
    ).toEqual({ note: "<script>alert('kept as text')</script>", executable: "#!/bin/sh" });
  });

  it("rejects oversized projections", () => {
    expect(() => jsonl([{ value: "x" }], { maxRecords: 0 })).toThrow();
  });
});
