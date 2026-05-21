import { describe, expect, it } from "vitest";
import { buildSearchIndex } from "../search.js";
import type { AirportRecord } from "../types.js";

const fra: AirportRecord = {
  id: 1,
  ident: "EDDF",
  type: "large_airport",
  iata: "FRA",
  icao: "EDDF",
  scheduledService: true,
  lat: 50.0379,
  lng: 8.5622,
  name: "Frankfurt am Main Airport",
  keywords: "FRA, EDDF, frankfurt",
};
const fkb: AirportRecord = {
  id: 2,
  ident: "EDSB",
  type: "medium_airport",
  iata: "FKB",
  icao: "EDSB",
  scheduledService: true,
  lat: 48.7794,
  lng: 8.0805,
  name: "Karlsruhe/Baden-Baden Airport",
  keywords: "Söllingen",
};
const eddf_tiny: AirportRecord = {
  id: 3,
  ident: "EDXY",
  type: "small_airport",
  scheduledService: false,
  lat: 53.0,
  lng: 7.0,
  name: "Some small airfield",
  keywords: "",
};

const index = buildSearchIndex([fra, fkb, eddf_tiny]);

describe("OurAirports search index", () => {
  it("exact IATA wins regardless of name overlap", () => {
    const results = index.query("FRA");
    expect(results[0]?.iata).toBe("FRA");
  });

  it("exact ICAO matches", () => {
    expect(index.query("EDDF")[0]?.icao).toBe("EDDF");
  });

  it("name prefix beats name-contains", () => {
    const results = index.query("frankfurt");
    expect(results[0]?.iata).toBe("FRA");
  });

  it("keyword match returns the airport", () => {
    const results = index.query("Söllingen");
    expect(results.some((r) => r.iata === "FKB")).toBe(true);
  });

  it("returns empty for missing query", () => {
    expect(index.query("")).toEqual([]);
  });

  it("byCode is case-insensitive and accepts whitespace", () => {
    expect(index.byCode("fra")?.iata).toBe("FRA");
    expect(index.byCode("  EDDF ")?.icao).toBe("EDDF");
  });

  it("byCode returns null for unknown codes", () => {
    expect(index.byCode("ZZZZ")).toBeNull();
  });
});
