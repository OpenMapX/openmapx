import { describe, expect, it } from "vitest";
import { parseOperatorUrl, validOperatorString } from "./configuration-values";

describe("shared operator string grammar", () => {
  it.each([
    "",
    "/local-dem/tiles.json",
    "/local-contours/tiles.json",
    "/tiles",
    "https://tiles.example/a?x=1",
    "http://localhost:3000/a",
  ])("accepts ordinary URL %s", (value) => expect(parseOperatorUrl(value)).toBe(value));
  it.each([
    "//other.test/a",
    "https://u:p@other.test/a",
    "javascript:alert(1)",
    "file:///etc/passwd",
    "/a\\b",
    "/a\nb",
    "/tiles/{z}",
    "http:/example.com",
    " https://example.com",
    "/" + "x".repeat(2048),
  ])("rejects unsafe ordinary URL %s", (value) => expect(parseOperatorUrl(value)).toBeUndefined());
  it("limits placeholders to actual tile consumer tokens", () => {
    expect(parseOperatorUrl("https://{s}.example.test/{z}/{x}/{y}", true)).toBe(
      "https://{s}.example.test/{z}/{x}/{y}",
    );
    expect(parseOperatorUrl("/{other}", true)).toBeUndefined();
  });
  it("bounds durations and matches pinned consumer units", () => {
    for (const value of ["0", "30m", "0.5h", "24h"])
      expect(validOperatorString(value, "ollama-duration"), value).toBe(true);
    for (const value of ["-1", "25h", "${SHELL}", "1e4h"])
      expect(validOperatorString(value, "ollama-duration"), value).toBe(false);
    for (const value of ["1h", "60m", "8760h"])
      expect(validOperatorString(value, "photon-duration"), value).toBe(true);
    for (const value of ["0h", "8761h", "0.5h"])
      expect(validOperatorString(value, "photon-duration"), value).toBe(false);
  });
  it("uses the existing region path grammar", () => {
    for (const value of ["planet", "europe/germany", "north-america/us"])
      expect(validOperatorString(value, "resource-region")).toBe(true);
    for (const value of ["../etc", "/europe", "Europe", "eu//de", "x/../y"])
      expect(validOperatorString(value, "resource-region")).toBe(false);
  });
});
