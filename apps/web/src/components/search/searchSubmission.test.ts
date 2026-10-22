import type { AutocompleteResult, SearchResult } from "@openmapx/core";
import { describe, expect, it } from "vitest";
import { decideSearchSubmission } from "./searchSubmission";

const address: SearchResult = {
  id: "osm:way/1",
  label: "Unter den Linden 77, Berlin",
  coordinates: [13.38, 52.516],
  type: "address",
  confidence: 1,
  provider: "synthetic-provider",
  sourceIds: ["synthetic-source"],
};
const base = {
  query: "Unter den Linden 77",
  rankedSuggestions: [] as AutocompleteResult[],
  proximity: [13.38, 52.516] as [number, number],
  zoom: 15,
  geocodeQuery: "Unter den Linden 77",
  geocodeResults: [address],
};

describe("plain Enter decision", () => {
  it("opens the ranked exact intent before considering geocoding", () => {
    const row: AutocompleteResult = { id: "cafes", label: "Cafes", type: "category" };
    expect(decideSearchSubmission({ ...base, query: "cafes", rankedSuggestions: [row] })).toEqual({
      kind: "open-row",
      row,
    });
  });

  it("keeps equally plausible distant places available for explicit choice", () => {
    const rows: AutocompleteResult[] = [
      { id: "a", label: "Springfield", coordinates: [-89.65, 39.78], type: "region", fame: 0.8 },
      { id: "b", label: "Springfield", coordinates: [-72.59, 42.1], type: "region", fame: 0.8 },
    ];
    expect(
      decideSearchSubmission({ ...base, query: "Springfield", rankedSuggestions: rows }),
    ).toEqual({ kind: "choose-row", row: rows[0] });
  });

  it("returns the original precise geocode result with its attribution and typed address", () => {
    const decision = decideSearchSubmission(base);
    expect(decision).toEqual({
      kind: "open-geocode",
      result: address,
      address: "Unter den Linden 77",
      isTransit: false,
    });
    if (decision.kind === "open-geocode") expect(decision.result).toBe(address);
  });

  it("ignores geocoding for the previous text", () => {
    expect(decideSearchSubmission({ ...base, geocodeQuery: "Unter den Linden" })).toEqual({
      kind: "search",
    });
  });

  it("allows a matching transit stop but leaves an ordinary POI to search", () => {
    const result: SearchResult = {
      ...address,
      label: "Berlin Hauptbahnhof",
      type: "poi",
      rawCategory: "railway/station",
    };
    const input = {
      ...base,
      query: result.label,
      geocodeQuery: result.label,
      geocodeResults: [result],
    };
    expect(decideSearchSubmission(input)).toEqual({
      kind: "open-geocode",
      result,
      address: undefined,
      isTransit: true,
    });
    expect(
      decideSearchSubmission({
        ...input,
        geocodeResults: [{ ...result, rawCategory: "shop/books" }],
      }),
    ).toEqual({ kind: "search" });
  });

  it("opens an address within a POI label without losing the POI record", () => {
    const result = {
      ...address,
      type: "poi" as const,
      label: "Adlon Kempinski, Unter den Linden 77, Berlin",
    };
    expect(decideSearchSubmission({ ...base, geocodeResults: [result] })).toEqual({
      kind: "open-geocode",
      result,
      address: "Unter den Linden 77",
      isTransit: false,
    });
  });

  it("searches rather than opening a low-coverage place or an empty result set", () => {
    expect(
      decideSearchSubmission({
        ...base,
        query: "Park mit See in Aachen",
        geocodeQuery: "Park mit See in Aachen",
        geocodeResults: [{ ...address, label: "Glen Park, Indiana" }],
      }),
    ).toEqual({ kind: "search" });
    expect(decideSearchSubmission({ ...base, geocodeResults: undefined })).toEqual({
      kind: "search",
    });
  });
});
