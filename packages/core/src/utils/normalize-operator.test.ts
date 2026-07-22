import { describe, expect, it } from "vitest";
import { matchesAnyOperator, normalizeOperator, operatorKeyMatches } from "./normalize-operator.js";

describe("normalizeOperator", () => {
  it("collapses legal suffixes and punctuation to a stable key", () => {
    expect(normalizeOperator("IONITY GmbH")).toBe("ionity");
    expect(normalizeOperator("Ionity")).toBe("ionity");
    expect(normalizeOperator("Fastned B.V.")).toBe("fastned");
    expect(normalizeOperator("  EnBW  ")).toBe("enbw");
    expect(normalizeOperator(undefined)).toBe("");
  });
});

describe("operatorKeyMatches", () => {
  it("matches a typed brand against the register's fuller name", () => {
    // The exact case a user hits: they type "EnBW", the register carries
    // "EnBW mobility+ AG und Co.KG".
    const typed = normalizeOperator("EnBW");
    const station = normalizeOperator("EnBW mobility+ AG und Co.KG");
    expect(station).not.toBe(typed); // equality would silently ignore the preference
    expect(operatorKeyMatches(typed, station)).toBe(true);
    expect(operatorKeyMatches(station, typed)).toBe(true); // direction must not matter
  });

  it("matches a brand against a site-specific operator name", () => {
    expect(
      operatorKeyMatches(normalizeOperator("Tesla"), normalizeOperator("Tesla Supercharger Köln")),
    ).toBe(true);
  });

  it("only matches from the first word, so unrelated networks stay distinct", () => {
    expect(operatorKeyMatches(normalizeOperator("Go"), normalizeOperator("EWE Go GmbH"))).toBe(
      false,
    );
    expect(operatorKeyMatches(normalizeOperator("EnBW"), normalizeOperator("E.ON"))).toBe(false);
    expect(operatorKeyMatches(normalizeOperator("Ionity"), normalizeOperator("Allego"))).toBe(
      false,
    );
  });

  it("never matches an empty key", () => {
    expect(operatorKeyMatches("", "enbw")).toBe(false);
    expect(operatorKeyMatches("enbw", "")).toBe(false);
  });
});

describe("matchesAnyOperator", () => {
  it("matches against any key in the user's list", () => {
    const keys = new Set(["tesla", "enbw"]);
    expect(matchesAnyOperator(normalizeOperator("EnBW mobility+ AG und Co.KG"), keys)).toBe(true);
    expect(matchesAnyOperator(normalizeOperator("Allego GmbH"), keys)).toBe(false);
  });

  it("is false for an empty key or missing list", () => {
    expect(matchesAnyOperator("", new Set(["tesla"]))).toBe(false);
    expect(matchesAnyOperator("tesla", undefined)).toBe(false);
  });
});
