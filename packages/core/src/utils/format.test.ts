import { describe, expect, it } from "vitest";
import { safeHref } from "./format";

describe("safeHref", () => {
  it("passes through http(s), mailto, tel, and relative URLs", () => {
    expect(safeHref("https://example.com/x?a=1&b=2")).toBe("https://example.com/x?a=1&b=2");
    expect(safeHref("http://example.com")).toBe("http://example.com");
    expect(safeHref("mailto:a@b.com")).toBe("mailto:a@b.com");
    expect(safeHref("tel:+15551234")).toBe("tel:+15551234");
    expect(safeHref("/local/path")).toBe("/local/path");
  });

  it("rejects dangerous and scheme-relative URLs", () => {
    expect(safeHref("javascript:alert(1)")).toBeUndefined();
    expect(safeHref("JavaScript:alert(1)")).toBeUndefined();
    expect(safeHref("  javascript:alert(1)")).toBeUndefined();
    expect(safeHref("java\tscript:alert(1)")).toBeUndefined();
    expect(safeHref("ja vascript:alert(1)")).toBeUndefined();
    expect(safeHref("data:text/html,<script>alert(1)</script>")).toBeUndefined();
    expect(safeHref("vbscript:msgbox(1)")).toBeUndefined();
    expect(safeHref("//evil.example.com")).toBeUndefined();
  });

  it("returns undefined for empty/nullish input", () => {
    expect(safeHref(undefined)).toBeUndefined();
    expect(safeHref(null)).toBeUndefined();
    expect(safeHref("")).toBeUndefined();
    expect(safeHref("   ")).toBeUndefined();
  });
});
