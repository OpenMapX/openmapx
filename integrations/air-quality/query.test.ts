import { describe, expect, it } from "vitest";

import { parsePointQuery, parseStationQuery } from "./query.js";

describe("canonical air-quality query parsing", () => {
  it.each([
    [{ lat: ["1", "2"], lng: "1" }, "lat"],
    [{ lat: "NaN", lng: "1" }, "lat"],
    [{ lat: "Infinity", lng: "1" }, "lat"],
    [{ lat: "91", lng: "1" }, "lat"],
    [{ lat: "1", lng: "181" }, "lng"],
    [{ lat: "1", lng: "1", countryCode: "de" }, "countryCode"],
    [{ lat: "1", lng: "1", subdivisionCode: "DE-" }, "subdivisionCode"],
    [{ lat: "1", lng: "1", comparisonStandard: "unknown" }, "comparisonStandard"],
    [{ lat: "1", lng: "1", hours: "0" }, "hours"],
    [{ lat: "1", lng: "1", hours: "121" }, "hours"],
    [{ lat: "1", lng: "1", hours: "1.5" }, "hours"],
  ] as const)("rejects invalid point query %#", (query, field) => {
    expect(() => parsePointQuery(query, { forecast: true, now: () => 0 })).toThrow(field);
  });

  it("canonicalizes point values once and creates a coordinate-free query hash", () => {
    const parsed = parsePointQuery(
      {
        lat: "52.520000",
        lng: "13.405000",
        countryCode: "DE",
        subdivisionCode: "DE-BE",
        comparisonStandard: "us-epa-2024",
        hours: "48",
      },
      { forecast: true, now: () => Date.parse("2026-08-30T12:34:56Z") },
    );
    expect(parsed).toMatchObject({
      latitude: 52.52,
      longitude: 13.405,
      countryCode: "DE",
      subdivisionCode: "DE-BE",
      comparisonStandard: "us-epa-2024",
      hours: 48,
      evaluatedAt: "2026-08-30T12:34:56.000Z",
    });
    expect(parsed.queryHash).toMatch(/^aq_q1_[A-Za-z0-9_-]{43}$/);
    expect(parsed.queryHash).not.toContain("52.52");
  });

  it.each([
    [{ south: ["1", "2"] }, "south"],
    [{ south: "0", west: "0", north: "21", east: "1", zoom: "5" }, "bbox"],
    [{ south: "0", west: "0", north: "1", east: "31", zoom: "5" }, "bbox"],
    [{ south: "1", west: "0", north: "0", east: "1", zoom: "5" }, "bbox"],
    [{ south: "0", west: "0", north: "1", east: "1", zoom: "23" }, "zoom"],
    [{ south: "0", west: "0", north: "1", east: "1", zoom: "1.5" }, "zoom"],
    [{ south: "0", west: "0", north: "1", east: "1", zoom: "5", limit: "0" }, "limit"],
    [{ south: "0", west: "0", north: "1", east: "1", zoom: "5", limit: "501" }, "limit"],
    [{ south: "0", west: "0", north: "1", east: "1", zoom: "5", pollutant: "lead" }, "pollutant"],
    [{ south: "0", west: "0", north: "1", east: "1", zoom: "5", cursor: ["a", "b"] }, "cursor"],
  ] as const)("rejects invalid station query %#", (query, field) => {
    expect(() => parseStationQuery(query)).toThrow(field);
  });

  it("accepts a bounded antimeridian bbox and binds the cursor outside its hash", () => {
    const parsed = parseStationQuery({
      south: "-5",
      west: "170",
      north: "5",
      east: "-170",
      zoom: "8",
      pollutant: "pm25",
      limit: "250",
      cursor: "opaque-token",
    });
    expect(parsed).toMatchObject({
      south: -5,
      west: 170,
      north: 5,
      east: -170,
      zoom: 8,
      pollutant: "pm25",
      limit: 250,
      cursor: "opaque-token",
    });
    expect(parsed.queryHash).toMatch(/^aq_q1_[A-Za-z0-9_-]{43}$/);
  });
});
