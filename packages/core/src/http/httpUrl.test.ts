import { describe, expect, it } from "vitest";
import { bareDomain } from "./httpUrl";

describe("bareDomain", () => {
  it.each([
    ["https://www.ubereats.com/", "ubereats.com"],
    ["https://wolt.com/de/deu", "wolt.com"],
    ["http://www.example.org:8080/a", "example.org:8080"],
  ])("reduces %s to its display host", (url, expected) => {
    expect(bareDomain(url)).toBe(expected);
  });

  it.each([
    ["www.lieferando.de/en", "www.lieferando.de"],
    ["lieferando.de", "lieferando.de"],
    ["https://", ""],
  ])("cuts the path from %s when URL cannot parse it", (url, expected) => {
    expect(bareDomain(url)).toBe(expected);
  });

  it("strips a long run of slashes without backtracking", () => {
    const started = performance.now();
    expect(bareDomain(`host${"/".repeat(50_000)}`)).toBe("host");
    expect(performance.now() - started).toBeLessThan(500);
  });
});
