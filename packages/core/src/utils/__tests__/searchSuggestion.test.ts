import { describe, expect, it } from "vitest";
import type { AutocompleteResult } from "../../types/geocoding";
import {
  compareSearchSuggestions,
  isUppercaseAcronymIntent,
  mergeAutocompleteSuggestions,
  normalizeSearchTerm,
  searchMatchTier,
} from "../searchSuggestion";

describe("search suggestion primitives", () => {
  it("normalizes case, Latin diacritics, punctuation, and whitespace", () => {
    expect(normalizeSearchTerm("  MÜNCHEN—Hbf  ")).toBe("munchen hbf");
  });

  it("detects only compact uppercase acronym intent", () => {
    expect(isUppercaseAcronymIntent("UNCC")).toBe(true);
    expect(isUppercaseAcronymIntent("A1")).toBe(true);
    expect(isUppercaseAcronymIntent("uncc")).toBe(false);
    expect(isUppercaseAcronymIntent("NEW YORK")).toBe(false);
    expect(isUppercaseAcronymIntent("A")).toBe(false);
    expect(isUppercaseAcronymIntent("ABCDEFGHI")).toBe(false);
  });

  it("keeps the approved tier ordering and equal explicit tiers", () => {
    expect(searchMatchTier("authoritative_code")).toBe(400);
    expect(searchMatchTier("explicit_reference")).toBe(300);
    expect(searchMatchTier("explicit_alias")).toBe(300);
    expect(searchMatchTier("name")).toBe(200);
    expect(searchMatchTier()).toBe(200);
    expect(searchMatchTier("generated_acronym")).toBe(100);
  });

  it("sorts by tier, exact text, importance, then proximity", () => {
    const exact: AutocompleteResult = {
      id: "exact",
      label: "Frankfurt Airport",
      coordinates: [9, 51],
      type: "poi",
      searchMatch: { kind: "explicit_alias", value: "FRA", normalized: "fra" },
      importance: 0.5,
    };
    const prefix: AutocompleteResult = {
      id: "prefix",
      label: "Fraser",
      coordinates: [8.5, 50],
      type: "poi",
      searchMatch: { kind: "explicit_alias", value: "Fraser", normalized: "fraser" },
      importance: 1,
    };
    expect(compareSearchSuggestions(exact, prefix, "FRA", [8.5, 50])).toBeLessThan(0);

    const important = { ...exact, id: "important", importance: 0.9 };
    expect(compareSearchSuggestions(important, exact, "FRA", [8.5, 50])).toBeLessThan(0);

    const nearby = { ...exact, id: "nearby", coordinates: [8.5, 50] as [number, number] };
    expect(compareSearchSuggestions(nearby, exact, "FRA", [8.5, 50])).toBeLessThan(0);
  });

  it("deduplicates a geocoder and catalog result without losing the stronger match", () => {
    const merged = mergeAutocompleteSuggestions(
      [
        {
          id: "geo:fra",
          label: "Frankfurt am Main Airport",
          coordinates: [8.57, 50.03],
          type: "poi",
          provider: "geocoder",
        },
        {
          id: "oa:EDDF",
          label: "Frankfurt am Main Airport",
          coordinates: [8.5701, 50.0301],
          type: "poi",
          ids: { icao: "EDDF", iata: "FRA" },
          searchMatch: { kind: "authoritative_code", value: "FRA", normalized: "fra" },
          importance: 0.9,
          provider: "knowledge-ourairports",
        },
      ],
      "FRA",
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      id: "oa:EDDF",
      ids: { icao: "EDDF", iata: "FRA" },
      searchMatch: { kind: "authoritative_code" },
      contributingProviders: ["knowledge-ourairports", "geocoder"],
    });
  });

  it("deduplicates shared external identities and unions identifiers and providers", () => {
    const merged = mergeAutocompleteSuggestions(
      [
        {
          id: "transit:one",
          label: "Berlin Hauptbahnhof",
          coordinates: [13.369, 52.525],
          type: "transit_stop",
          ids: { uic: "8011160", transit: "one" },
          provider: "transit",
          contributingProviders: ["transit", "db"],
        },
        {
          id: "osm:node/123",
          label: "Berlin Hauptbahnhof",
          coordinates: [13.37, 52.526],
          type: "poi",
          ids: { uic: "8011160", osm: "node/123" },
          searchMatch: { kind: "explicit_reference", value: "8011160", normalized: "8011160" },
          importance: 0.8,
          provider: "search-osm-aliases",
        },
      ],
      "8011160",
    );
    expect(merged).toHaveLength(1);
    expect(merged[0].ids).toEqual({ uic: "8011160", osm: "node/123", transit: "one" });
    expect(merged[0].contributingProviders).toEqual(["search-osm-aliases", "transit", "db"]);
  });

  it("does not coordinate-deduplicate different canonical labels", () => {
    const merged = mergeAutocompleteSuggestions(
      [
        { id: "one", label: "Central Hotel", coordinates: [7, 50], type: "poi" },
        { id: "two", label: "Central Station", coordinates: [7, 50], type: "poi" },
      ],
      "central",
    );
    expect(merged).toHaveLength(2);
  });
});
