import { describe, expect, it } from "vitest";
import { diceSimilarity, nameSimilarity, normalizeName } from "../geo-server";

describe("normalizeName", () => {
  it("lowercases", () => {
    expect(normalizeName("PENNY")).toBe("penny");
  });

  it("strips diacritics", () => {
    expect(normalizeName("Schöneberg")).toBe("schoneberg");
    expect(normalizeName("Café")).toBe("cafe");
  });

  it("collapses punctuation and whitespace to single spaces", () => {
    expect(normalizeName("U-Bahnhof  Lindauer Allee")).toBe("u bahnhof lindauer allee");
    expect(normalizeName("  KFC #189  ")).toBe("kfc 189");
  });

  it("returns empty for a name with no alphanumerics", () => {
    expect(normalizeName("—")).toBe("");
  });
});

describe("nameSimilarity", () => {
  it("matches names differing only by case (the dominant cheap miss)", () => {
    // Raw char-Dice scores 0 here because bigrams are case-sensitive.
    expect(diceSimilarity("PENNY", "Penny")).toBe(0);
    expect(nameSimilarity("PENNY", "Penny")).toBe(1);
  });

  it("matches names differing only by accents", () => {
    expect(nameSimilarity("Schöneberg", "Schoneberg")).toBe(1);
  });

  it("matches via shared distinctive tokens despite prefix/suffix noise", () => {
    // Char-Dice is ~0.74 (below the 0.8 floor); token-Dice rescues it.
    expect(nameSimilarity("U Lindauer Allee", "U-Bahnhof Lindauer Allee")).toBeGreaterThanOrEqual(
      0.8,
    );
  });

  it("matches reordered word tokens", () => {
    expect(nameSimilarity("Trattoria La Marina", "La Marina Trattoria")).toBeGreaterThanOrEqual(
      0.8,
    );
  });

  it("does NOT match unrelated names (precision guard)", () => {
    expect(nameSimilarity("Aldi", "Lidl")).toBeLessThan(0.8);
    expect(nameSimilarity("Mazda Dealer", "Edeka Peth")).toBeLessThan(0.8);
  });

  it("does NOT match a bare brand token against a longer phrase (Tier-3 territory)", () => {
    // "Aral" vs "ARAL Station": one shared token out of {aral} vs {aral, station}.
    // Token-Dice = 2/3 < 0.8 — left for brand normalization, not over-matched here.
    expect(nameSimilarity("Aral", "ARAL Station")).toBeLessThan(0.8);
  });

  it("returns 0 for two blank/placeholder names (never match empties)", () => {
    expect(nameSimilarity("", "")).toBe(0);
    expect(nameSimilarity("—", "·")).toBe(0);
  });
});
