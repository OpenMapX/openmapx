import { describe, expect, it } from "vitest";
import {
  diceSimilarity,
  nameSimilarity,
  normalizeName,
  normalizePhone,
  normalizeStreet,
  osmAddressKey,
  overtureAddressKey,
  parsePhones,
  websiteDomain,
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

describe("normalizePhone", () => {
  it("folds +49 / 0049 / leading-0 trunk prefixes to one canonical form", () => {
    const canonical = normalizePhone("+49 30 31806750");
    expect(canonical).toBe("3031806750");
    expect(normalizePhone("0049 30 318 06 750")).toBe(canonical);
    expect(normalizePhone("030 31806750")).toBe(canonical);
    expect(normalizePhone("(030) 318-067-50")).toBe(canonical);
  });

  it("distinguishes genuinely different numbers", () => {
    expect(normalizePhone("030 12345678")).not.toBe(normalizePhone("030 87654321"));
  });

  it("does NOT strip a leading 49 from a bare local number (no +/00 prefix)", () => {
    // "49" is folded as a country code only when the input was explicitly
    // international; a plain number that merely starts with 49 keeps its digits.
    expect(normalizePhone("4912345")).toBe("4912345");
    expect(normalizePhone("+49 89 1234")).toBe("891234");
  });

  it("returns null for missing or too-short input", () => {
    expect(normalizePhone(null)).toBeNull();
    expect(normalizePhone("")).toBeNull();
    expect(normalizePhone("12 34")).toBeNull();
  });
});

describe("parsePhones", () => {
  it("splits a multi-value OSM tag and canonicalizes each number", () => {
    expect(parsePhones("+49 30 111111; +49 30 222222")).toEqual(["30111111", "30222222"]);
  });

  it("canonicalizes and dedupes an Overture phones[] array", () => {
    expect(parsePhones(["+49 30 111111", "030 111111"])).toEqual(["30111111"]);
  });

  it("returns an empty array for null/empty/too-short values", () => {
    expect(parsePhones(null)).toEqual([]);
    expect(parsePhones("")).toEqual([]);
    expect(parsePhones(["123", "45"])).toEqual([]);
  });
});

describe("websiteDomain", () => {
  it("strips scheme, www, path and query to the bare host", () => {
    expect(websiteDomain("https://www.Edeka.de/markt/berlin?ref=x")).toBe("edeka.de");
    expect(websiteDomain("http://edeka.de")).toBe("edeka.de");
    expect(websiteDomain("edeka.de/foo")).toBe("edeka.de");
  });

  it("drops userinfo and port so they don't block equal-domain corroboration", () => {
    expect(websiteDomain("http://info@edeka.de")).toBe("edeka.de");
    expect(websiteDomain("https://edeka.de:443/x")).toBe("edeka.de");
    expect(websiteDomain("//edeka.de")).toBe("edeka.de");
  });

  it("returns null when no host can be parsed", () => {
    expect(websiteDomain(null)).toBeNull();
    expect(websiteDomain("")).toBeNull();
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
