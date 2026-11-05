import { describe, expect, it } from "vitest";
import { canonicalFeedCredentialMap } from "./feed-credential-map";

describe("canonical feed credential map", () => {
  it("refuses non-JSON whitespace rather than repairing an invalid retained map", () => {
    expect(() => canonicalFeedCredentialMap('{\u000b"a":"value"}')).toThrow();
  });
  it("accepts exactly 65536 canonical UTF-8 bytes and rejects the next byte", () => {
    const values = Object.fromEntries(
      Array.from({ length: 8 }, (_, index) => [`k${index}`, "x".repeat(index === 7 ? 8127 : 8192)]),
    );
    const accepted = canonicalFeedCredentialMap(values);
    expect(Buffer.byteLength(accepted)).toBe(65536);
    values.k7 += "x";
    expect(() => canonicalFeedCredentialMap(values)).toThrow();
  });
  it("preserves orphan keys, sorts keys and counts code points independently of UTF-8 values", () => {
    const key = "😀".repeat(512);
    const value = canonicalFeedCredentialMap({ z: "old orphan", [key]: 'ü\\"', a: "retained" });
    expect(JSON.parse(value)).toEqual({ z: "old orphan", [key]: 'ü\\"', a: "retained" });
    expect(value.startsWith('{"a":')).toBe(true);
    expect(() => canonicalFeedCredentialMap({ [key + "x"]: "" })).toThrow();
  });
  it.each([
    '{"a":"one","a":"two"}',
    '{"a":"one","\\u0061":"two"}',
    '{"constructor":"bad"}',
    '{"a":2}',
    '{"a":"\\ud800"}',
  ])("refuses duplicate, unsafe, non-string and invalid-Unicode input", (input) => {
    expect(() => canonicalFeedCredentialMap(input)).toThrow();
  });
  it("enforces the 1000-key and 8192-byte value bounds", () => {
    expect(() =>
      canonicalFeedCredentialMap(
        Object.fromEntries(Array.from({ length: 1001 }, (_, index) => [`k${index}`, ""])),
      ),
    ).toThrow();
    expect(() => canonicalFeedCredentialMap({ a: "ü".repeat(4097) })).toThrow();
  });
});
