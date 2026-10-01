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

  it("preserves authoritative code match evidence", () => {
    expect(index.queryMatches("FRA")[0]).toMatchObject({
      record: { iata: "FRA" },
      kind: "authoritative_code",
      matchedValue: "FRA",
      namespace: "iata",
    });
    expect(index.queryMatches("EDDF")[0]).toMatchObject({
      kind: "authoritative_code",
      matchedValue: "EDDF",
      namespace: "icao",
    });
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

  it("reports a keyword match as a keyword, not as the airport's name", () => {
    // Keywords hold city names ("Köln") and plain tags ("restaurant") too.
    expect(index.queryMatches("Söllingen")[0]).toMatchObject({
      record: { iata: "FKB" },
      kind: "keyword",
      matchedValue: "Söllingen",
    });
  });

  it("matches only codes people type, not GPS or local filing codes", () => {
    const strip: AirportRecord = {
      id: 4,
      ident: "PG-0045",
      type: "small_airport",
      icao: "AYBJ",
      localCode: "BANK",
      gpsCode: "AYBJ",
      scheduledService: false,
      lat: -6,
      lng: 145,
      name: "Bank Airstrip",
      keywords: "",
    };
    const withStrip = buildSearchIndex([fra, strip]);
    expect(withStrip.queryMatches("bank")[0]).toMatchObject({ kind: "name" });
    expect(withStrip.queryMatches("AYBJ")[0]).toMatchObject({
      kind: "authoritative_code",
      namespace: "icao",
    });
    // Looking a known code up directly still works for every code.
    expect(withStrip.byCode("BANK")?.id).toBe(4);
  });

  it("reports the start of a keyword as a keyword match too", () => {
    expect(index.queryMatches("Söll")[0]).toMatchObject({
      record: { iata: "FKB" },
      kind: "keyword",
      matchedValue: "Söllingen",
    });
  });

  it("matches names and keywords only at word starts", () => {
    expect(index.query("furt")).toEqual([]);
    expect(index.query("lingen")).toEqual([]);
    expect(index.query("baden")[0]?.iata).toBe("FKB");
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
