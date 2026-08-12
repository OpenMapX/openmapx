import { describe, expect, it } from "vitest";
import {
  deriveImportance,
  extractTerms,
  generateAcronym,
  isSearchableFeature,
  normalizeSearchTerm,
} from "../../src/jobs/search-index/terms.js";

describe("search index term policy", () => {
  it("normalizes terms exactly like consumer search", () => {
    expect(normalizeSearchTerm("  MÜNCHEN—Hbf  ")).toBe("munchen hbf");
    expect(normalizeSearchTerm("A.B.C.")).toBe("a b c");
  });
  it("generates approved institutional acronyms with English and German stopwords", () => {
    expect(
      generateAcronym("University of North Carolina at Charlotte", { amenity: "university" }),
    ).toBe("UNCC");
    expect(generateAcronym("Museum of Modern Art", { tourism: "museum" })).toBe("MOMA");
    expect(generateAcronym("Museum für Kunst und Gewerbe", { tourism: "museum" })).toBe("MKG");
  });

  it("does not generate acronyms for generic businesses or invalid lengths", () => {
    expect(generateAcronym("Joe's Coffee Shop", { amenity: "cafe" })).toBeNull();
    expect(generateAcronym("University", { amenity: "university" })).toBeNull();
    expect(
      generateAcronym("Alpha Bravo Charlie Delta Echo Foxtrot Golf Hotel India", {
        amenity: "university",
      }),
    ).toBeNull();
  });

  it("extracts only approved aliases and code namespaces", () => {
    const terms = extractTerms({
      name: "Example Institute",
      short_name: "EX; EI ; EX",
      alt_name: "Example Academy",
      old_name: "Former Example",
      "ref:IFOPT": "de:123",
      "ref:utility": "secret-7",
      amenity: "university",
    });
    expect(terms).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "explicit_alias", displayValue: "EX" }),
        expect.objectContaining({ kind: "authoritative_code", namespace: "ref:IFOPT" }),
      ]),
    );
    expect(terms.filter((term) => term.displayValue === "EX")).toHaveLength(1);
    expect(terms.some((term) => term.namespace === "ref:utility")).toBe(false);
    expect(terms.some((term) => term.displayValue === "Former Example")).toBe(false);
  });

  it("allows generic ref only for selected place and transport features", () => {
    expect(extractTerms({ name: "Berlin", place: "city", ref: "BE" })).toContainEqual(
      expect.objectContaining({ kind: "explicit_reference", namespace: "ref" }),
    );
    expect(extractTerms({ name: "Cafe", amenity: "cafe", ref: "table-4" })).not.toContainEqual(
      expect.objectContaining({ namespace: "ref" }),
    );
  });

  it("applies the closed feature allowlist", () => {
    expect(isSearchableFeature({ name: "Berlin", place: "city" })).toBe(true);
    expect(isSearchableFeature({ name: "Airport", aeroway: "aerodrome" })).toBe(true);
    expect(isSearchableFeature({ name: "House", building: "yes" })).toBe(false);
    expect(isSearchableFeature({ name: "Road", highway: "primary" })).toBe(false);
    expect(isSearchableFeature({ name: "Unknown", "ref:iata": "XYZ" })).toBe(true);
  });

  it("derives bounded importance values", () => {
    expect(deriveImportance({ place: "city" })).toBe(0.9);
    expect(deriveImportance({ amenity: "university" })).toBe(0.7);
    expect(deriveImportance({ amenity: "cafe" })).toBe(0.5);
    expect(deriveImportance({ place: "city", wikidata: "Q64" })).toBe(1);
  });
});
