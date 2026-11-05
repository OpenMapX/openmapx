import { expect, it, vi } from "vitest";
import {
  canonicalFeedCredentialMap,
  mergeFeedCredentialTemplate,
  parseFeedCredentialMapJson,
  validateFeedCredentialMap,
} from "../src/feed-credentials";

it("preserves retained values and orphaned keys without trimming or silent deletion", () => {
  const result = mergeFeedCredentialTemplate(
    { "de/required": "  secret\n", orphan: "retained", empty: "" },
    ["de/required", "at/new"],
  );
  expect(result.values).toEqual({
    "de/required": "  secret\n",
    orphan: "retained",
    empty: "",
    "at/new": "",
  });
  expect(result.orphanedKeys).toEqual(["empty", "orphan"]);
  expect(result.droppedCount).toBe(0);
  expect(
    validateFeedCredentialMap(result.values, [{ key: "at/new", action: "set", value: " next " }])
      .values.orphan,
  ).toBe("retained");
});
it("sorts canonical keys by code-unit order including integer-looking keys", () => {
  expect(canonicalFeedCredentialMap({ "2": "b", "10": "a", z: " ", a: "\n" }).canonicalJson).toBe(
    '{"10":"a","2":"b","a":"\\n","z":" "}',
  );
});
it.each([
  '{"a":"one","a":"two"}',
  '{"a":"one","\\u0061":"two"}',
  "[]",
  '{"a":null}',
  '{"__proto__":"bad"}',
  '{"a":"\\ud800"}',
  '{"\\ud800":"v"}',
  '{"a":"v",}',
])("refuses malformed/duplicate/unsafe input without leaking its body: %s", (raw) => {
  expect(() => parseFeedCredentialMapJson(raw)).toThrow(/Feed credential/);
});
it("validates the final aggregate using UTF-8 and re-escaped canonical bytes", () => {
  const values = Object.fromEntries(
    Array.from({ length: 8 }, (_, n) => [String(n), "x".repeat(8192)]),
  );
  expect(() => canonicalFeedCredentialMap(values)).toThrow(/budget/);
  const fixed = validateFeedCredentialMap(values, [{ key: "7", action: "delete" }]);
  expect(fixed.entryCount).toBe(7);
  expect(fixed.utf8Bytes).toBe(new TextEncoder().encode(fixed.canonicalJson).byteLength);
  expect(() => canonicalFeedCredentialMap({ a: "ü".repeat(4097) })).toThrow(/budget/);
  expect(() => canonicalFeedCredentialMap({ a: '"'.repeat(8193) })).toThrow(/budget/);
  const thousand = Object.fromEntries(Array.from({ length: 1000 }, (_, n) => [`key${n}`, ""]));
  expect(canonicalFeedCredentialMap(thousand).entryCount).toBe(1000);
  expect(() => canonicalFeedCredentialMap({ ...thousand, extra: "" })).toThrow(/budget/);
});
it("rejects duplicate mutations, malformed Unicode and overlong keys", () => {
  expect(() =>
    validateFeedCredentialMap({ a: "v" }, [
      { key: "a", action: "delete" },
      { key: "a", action: "set", value: "v" },
    ]),
  ).toThrow();
  expect(() => canonicalFeedCredentialMap({ ["ü".repeat(513)]: "v" })).toThrow();
  expect(canonicalFeedCredentialMap({ ["😀".repeat(512)]: "v" }).entryCount).toBe(1);
  expect(() => canonicalFeedCredentialMap({ a: "\ud800" })).toThrow();
});
it("lets a legacy aggregate be corrected only when the complete merged map is valid", () => {
  const raw = JSON.stringify(
    Object.fromEntries(Array.from({ length: 9 }, (_, n) => [String(n), "x".repeat(8192)])),
  );
  const existing = parseFeedCredentialMapJson(raw);
  expect(() => validateFeedCredentialMap(existing, [{ key: "0", action: "delete" }])).toThrow();
  expect(
    validateFeedCredentialMap(existing, [
      { key: "0", action: "delete" },
      { key: "1", action: "delete" },
    ]).entryCount,
  ).toBe(7);
});

it("accepts exactly65536 canonical bytes and refuses65537 after escaping", () => {
  const values: Record<string, string> = Object.fromEntries(
    Array.from({ length: 8 }, (_, n) => [String(n), n === 7 ? "" : "x".repeat(8192)]),
  );
  const base = new TextEncoder().encode(JSON.stringify(values)).byteLength;
  values["7"] = "x".repeat(65536 - base);
  expect(canonicalFeedCredentialMap(values).utf8Bytes).toBe(65536);
  values["7"] += "x";
  expect(() => canonicalFeedCredentialMap(values)).toThrow(/budget/);
  expect(() =>
    canonicalFeedCredentialMap(
      Object.fromEntries(Array.from({ length: 8 }, (_, n) => [String(n), '"'.repeat(8192)])),
    ),
  ).toThrow(/budget/);
});

it("keeps the portable data validator independent of DOM encoding globals", async () => {
  vi.stubGlobal("TextEncoder", undefined);
  vi.resetModules();
  try {
    const module = await import("../src/feed-credentials");
    expect(module.canonicalFeedCredentialMap({ emoji: "😀", accent: "ü" }).utf8Bytes).toBe(30);
  } finally {
    vi.unstubAllGlobals();
    vi.resetModules();
  }
});
