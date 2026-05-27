import { describe, expect, it } from "vitest";
import { type I18nToken, isI18nToken } from "../index.js";

describe("I18nToken", () => {
  it("isI18nToken recognises the canonical shape", () => {
    const a: I18nToken = { $t: "shared.row.source" };
    const b: I18nToken = { $t: "row.freeSpaces", values: { free: 3, capacity: 10 } };
    expect(isI18nToken(a)).toBe(true);
    expect(isI18nToken(b)).toBe(true);
  });

  it("isI18nToken rejects strings, numbers, null, and unrelated objects", () => {
    expect(isI18nToken("Free Spaces")).toBe(false);
    expect(isI18nToken(42)).toBe(false);
    expect(isI18nToken(null)).toBe(false);
    expect(isI18nToken(undefined)).toBe(false);
    expect(isI18nToken({ key: "row.foo" })).toBe(false);
    expect(isI18nToken({ $t: 42 })).toBe(false);
  });
});
