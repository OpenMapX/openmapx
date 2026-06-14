import { describe, expect, it } from "vitest";
import { safeEqual } from "../safe-equal";

describe("safeEqual", () => {
  it("returns true for identical non-empty strings", () => {
    expect(safeEqual("s3cr3t-token", "s3cr3t-token")).toBe(true);
  });

  it("returns false for same-length strings that differ", () => {
    expect(safeEqual("abcdef", "abcxef")).toBe(false);
  });

  it("returns false for strings of different lengths", () => {
    expect(safeEqual("short", "longer-string")).toBe(false);
  });

  it("returns false when one string is a prefix of the other", () => {
    expect(safeEqual("secret", "secret-extra")).toBe(false);
  });

  it("returns true for two empty strings", () => {
    expect(safeEqual("", "")).toBe(true);
  });

  it("returns false when only one string is empty", () => {
    expect(safeEqual("", "x")).toBe(false);
    expect(safeEqual("x", "")).toBe(false);
  });

  it("distinguishes a single trailing character", () => {
    expect(safeEqual("token", "tokens")).toBe(false);
  });

  it("treats comparison as case-sensitive", () => {
    expect(safeEqual("Token", "token")).toBe(false);
  });

  it("compares multi-byte UTF-8 strings by byte content", () => {
    // Precomposed e-acute (U+00E9, 2 UTF-8 bytes) vs decomposed e + combining
    // accent (U+0065 U+0301, 3 UTF-8 bytes) differ in byte length, so not equal.
    const precomposed = "caf\u00E9";
    const decomposed = "cafe\u0301";
    expect(safeEqual(precomposed, precomposed)).toBe(true);
    expect(safeEqual(precomposed, decomposed)).toBe(false);
  });

  it("returns true for equal strings containing multi-byte characters", () => {
    expect(safeEqual("日本語", "日本語")).toBe(true);
  });

  it("returns false for equal-byte-length but differing multi-byte strings", () => {
    expect(safeEqual("日本", "日語")).toBe(false);
  });

  it("always returns a boolean across every branch", () => {
    const cases: Array<[string, string]> = [
      ["", ""],
      ["a", ""],
      ["", "a"],
      ["a", "a"],
      ["a", "b"],
      ["ab", "abc"],
      ["café", "café"],
    ];
    for (const [a, b] of cases) {
      expect(typeof safeEqual(a, b)).toBe("boolean");
    }
  });
});
