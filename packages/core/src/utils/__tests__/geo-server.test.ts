import { describe, expect, it } from "vitest";
import {
  diceSimilarity,
  nameSimilarity,
  normalizeName,
  normalizeStreet,
  osmAddressKey,
  overtureAddressKey,
} from "../geo-server";

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

  it("folds ß to ss (so it isn't dropped by diacritic stripping)", () => {
    expect(normalizeName("Weißensee")).toBe("weissensee");
    expect(normalizeName("Straße")).toBe("strasse");
  });

  it("returns empty for a name with no alphanumerics", () => {
    expect(normalizeName("—")).toBe("");
  });
});

describe("address keys", () => {
  it("normalizeStreet folds German street-type abbreviations", () => {
    expect(normalizeStreet("Karl-Liebknecht-Straße")).toBe(normalizeStreet("Karl-Liebknecht-Str."));
  });

  it("normalizeStreet folds compound (one-token) street suffixes", () => {
    // Schloßstraße / Schloßstr. are one token — the fold must be global, not word-bounded.
    expect(normalizeStreet("Schloßstraße")).toBe(normalizeStreet("Schloßstr."));
    expect(normalizeStreet("Hauptstraße")).toBe("hauptstr");
  });

  it("osmAddressKey and overtureAddressKey agree for the same address", () => {
    const osm = osmAddressKey("Karl-Liebknecht-Straße", "131", "14482");
    const ov = overtureAddressKey("Karl-Liebknecht-Str. 131", "14482");
    expect(osm).not.toBeNull();
    expect(osm).toBe(ov);
  });

  it("different house numbers produce different keys", () => {
    expect(osmAddressKey("Hauptstraße", "5", "10115")).not.toBe(
      osmAddressKey("Hauptstraße", "7", "10115"),
    );
  });

  it("returns null when a component is missing", () => {
    expect(osmAddressKey("Hauptstraße", null, "10115")).toBeNull();
    expect(overtureAddressKey("Hauptstraße", null)).toBeNull();
    expect(overtureAddressKey("NoNumberHere", "10115")).toBeNull();
  });

  it("parses a house-number range to its first number", () => {
    expect(overtureAddressKey("Großbeerenstraße 249-253", "14480")).toBe(
      osmAddressKey("Großbeerenstraße", "249", "14480"),
    );
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
