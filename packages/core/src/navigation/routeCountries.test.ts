import { describe, expect, it } from "vitest";
import type { MatchResult } from "../types/routing";
import { appendCountrySpans, countryAtMeters, matchCountriesByPoint } from "./routeCountries";

describe("route countries", () => {
  it("reads each matched point's country from its edge", () => {
    const match: MatchResult = {
      geometry: [],
      mode: "driving",
      edges: [
        { length: 1, beginShapeIndex: 0, endShapeIndex: 1, endNodeCountryCode: "NL" },
        { length: 1, beginShapeIndex: 1, endShapeIndex: 2 },
      ],
      points: [
        { lat: 0, lng: 0, type: "matched", edgeIndex: 0 },
        { lat: 0, lng: 0, type: "matched", edgeIndex: 1 },
        { lat: 0, lng: 0, type: "unmatched" },
      ],
    };
    expect(matchCountriesByPoint(match)).toEqual(["NL", null, null]);
  });

  it("opens a span only where the country changes, across windows", () => {
    const cum = [0, 100, 200, 300, 400, 500];
    const first = appendCountrySpans([], cum, 0, ["NL", null, "NL"]);
    const both = appendCountrySpans(first, cum, 3, ["NL", "DE", "DE"]);
    expect(both).toEqual([
      { fromMeters: 0, countryCode: "NL" },
      { fromMeters: 400, countryCode: "DE" },
    ]);
    expect(first).toHaveLength(1);
  });

  it("answers the country at a distance along the route", () => {
    const spans = [
      { fromMeters: 50, countryCode: "NL" },
      { fromMeters: 400, countryCode: "DE" },
    ];
    expect(countryAtMeters(spans, 10)).toBeUndefined();
    expect(countryAtMeters(spans, 50)).toBe("NL");
    expect(countryAtMeters(spans, 399)).toBe("NL");
    expect(countryAtMeters(spans, 1200)).toBe("DE");
  });
});
