import { afterEach, describe, expect, it, vi } from "vitest";
import { deduplicateParking, haversineMeters } from "../dedup.js";
import type { ParkingFacility } from "../types.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function makeFacility(
  overrides: Partial<ParkingFacility> & Pick<ParkingFacility, "id" | "coordinates" | "sources">,
): ParkingFacility {
  return {
    name: "Parking Lot",
    parkingType: "unknown",
    hasRealtimeData: false,
    ...overrides,
  };
}

describe("deduplicateParking", () => {
  it("returns empty array for empty input", () => {
    expect(deduplicateParking([])).toEqual([]);
  });

  it("returns single facility unchanged", () => {
    const f = makeFacility({ id: "p1", coordinates: [13.377, 52.52], sources: ["osm"] });
    const result = deduplicateParking([f]);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("p1");
  });

  it("clusters two facilities within the always-merge distance (~30m)", () => {
    const a = makeFacility({
      id: "db-1",
      coordinates: [13.3771, 52.5201],
      sources: ["db-bahnpark"],
      name: "DB Parking",
    });
    const b = makeFacility({
      id: "osm-1",
      coordinates: [13.3774, 52.5204],
      sources: ["osm"],
      name: "OSM Parking",
    });
    const result = deduplicateParking([a, b]);
    expect(result).toHaveLength(1);
  });

  it("keeps facilities that are far apart", () => {
    const a = makeFacility({
      id: "p1",
      coordinates: [13.377, 52.52],
      sources: ["osm"],
    });
    const b = makeFacility({
      id: "p2",
      coordinates: [13.39, 52.54],
      sources: ["osm"],
    });
    const result = deduplicateParking([a, b]);
    expect(result).toHaveLength(2);
  });

  describe("distance-based clustering", () => {
    it("merges facilities <40m apart regardless of name", () => {
      // Δlat 0.0002 ≈ 22m, Δlng 0.0002 ≈ 14m → ~26m
      const a = makeFacility({
        id: "a",
        coordinates: [13.377, 52.5201],
        sources: ["osm"],
        name: "Totally Different Name",
      });
      const b = makeFacility({
        id: "b",
        coordinates: [13.3772, 52.5203],
        sources: ["osm"],
        name: "Another Unrelated Lot",
      });
      const result = deduplicateParking([a, b]);
      expect(result).toHaveLength(1);
    });

    it("merges facilities 40–150m apart when names agree", () => {
      // ~80m apart
      const a = makeFacility({
        id: "a",
        coordinates: [13.377, 52.521],
        sources: ["parkapi-v2/Köln"],
        name: "Parkhaus Rathaus",
      });
      const b = makeFacility({
        id: "b",
        coordinates: [13.377, 52.5217],
        sources: ["osm"],
        name: "Rathaus P1",
      });
      const result = deduplicateParking([a, b]);
      expect(result).toHaveLength(1);
    });

    it("does not merge 40–150m apart when names disagree", () => {
      const a = makeFacility({
        id: "a",
        coordinates: [13.377, 52.521],
        sources: ["osm"],
        name: "Parkhaus Rathaus",
      });
      const b = makeFacility({
        id: "b",
        coordinates: [13.377, 52.5217],
        sources: ["osm"],
        name: "Parkhaus Kaufhof",
      });
      const result = deduplicateParking([a, b]);
      expect(result).toHaveLength(2);
    });

    it("never merges beyond ~150m", () => {
      // ~250m apart
      const a = makeFacility({
        id: "a",
        coordinates: [13.377, 52.521],
        sources: ["osm"],
        name: "Rathaus",
      });
      const b = makeFacility({
        id: "b",
        coordinates: [13.377, 52.5233],
        sources: ["osm"],
        name: "Rathaus",
      });
      const result = deduplicateParking([a, b]);
      expect(result).toHaveLength(2);
    });

    it("does not merge on-street with a garage even at close range", () => {
      const a = makeFacility({
        id: "a",
        coordinates: [13.377, 52.521],
        sources: ["osm"],
        parkingType: "on-street",
      });
      const b = makeFacility({
        id: "b",
        coordinates: [13.3771, 52.5211],
        sources: ["osm"],
        parkingType: "garage",
      });
      const result = deduplicateParking([a, b]);
      expect(result).toHaveLength(2);
    });
  });

  describe("source priority", () => {
    it("db-bahnpark (0) wins over parkapi-v3 (1)", () => {
      const db = makeFacility({
        id: "db-1",
        coordinates: [13.377, 52.52],
        sources: ["db-bahnpark"],
        name: "DB Station Parking",
      });
      const parkapi = makeFacility({
        id: "pv3-1",
        coordinates: [13.3772, 52.5202],
        sources: ["parkapi-v3"],
        name: "ParkAPI Parking",
      });
      const result = deduplicateParking([parkapi, db]);
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("db-1");
      expect(result[0].name).toBe("DB Station Parking");
      expect(result[0].sources[0]).toBe("db-bahnpark");
    });

    it("parkapi-v3 (1) wins over parkapi-v2 (2)", () => {
      const v3 = makeFacility({
        id: "pv3-1",
        coordinates: [13.377, 52.52],
        sources: ["parkapi-v3"],
        name: "V3 Parking",
      });
      const v2 = makeFacility({
        id: "pv2-1",
        coordinates: [13.3772, 52.5202],
        sources: ["parkapi-v2/Dresden"],
        name: "V2 Parking",
      });
      const result = deduplicateParking([v2, v3]);
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("pv3-1");
      expect(result[0].sources[0]).toBe("parkapi-v3");
    });

    it("parkapi-v2 (2) wins over osm-parking (5)", () => {
      const v2 = makeFacility({
        id: "pv2-1",
        coordinates: [13.377, 52.52],
        sources: ["parkapi-v2/Berlin"],
        name: "V2 Parking",
      });
      const osm = makeFacility({
        id: "osm-1",
        coordinates: [13.3772, 52.5202],
        sources: ["osm"],
        name: "OSM Parking",
      });
      const result = deduplicateParking([osm, v2]);
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("pv2-1");
      expect(result[0].sources[0]).toBe("parkapi-v2/Berlin");
    });

    it("prefix match: parkapi-v2/CityName gets priority 2", () => {
      const v2 = makeFacility({
        id: "pv2-1",
        coordinates: [13.377, 52.52],
        sources: ["parkapi-v2/Dresden"],
        name: "Rathaus",
      });
      const osm = makeFacility({
        id: "osm-1",
        coordinates: [13.3772, 52.5202],
        sources: ["osm"],
        name: "Rathaus",
      });
      const result = deduplicateParking([osm, v2]);
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("pv2-1");
    });

    it("unknown source gets priority 99", () => {
      const unknown = makeFacility({
        id: "unk-1",
        coordinates: [13.377, 52.52],
        sources: ["some-new-provider"],
        name: "Rathaus",
      });
      const osm = makeFacility({
        id: "osm-1",
        coordinates: [13.3772, 52.5202],
        sources: ["osm"],
        name: "Rathaus",
      });
      const result = deduplicateParking([unknown, osm]);
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("osm-1");
    });
  });

  describe("field merging", () => {
    it("identity fields come from primary (higher priority)", () => {
      const db = makeFacility({
        id: "db-1",
        coordinates: [13.377, 52.52],
        sources: ["db-bahnpark"],
        name: "DB Parking Hbf",
      });
      const osm = makeFacility({
        id: "osm-1",
        coordinates: [13.3772, 52.5202],
        sources: ["osm"],
        name: "OSM Parking Hbf",
      });
      const result = deduplicateParking([db, osm]);
      expect(result[0].id).toBe("db-1");
      expect(result[0].name).toBe("DB Parking Hbf");
      expect(result[0].coordinates).toEqual([13.377, 52.52]);
      expect(result[0].sources[0]).toBe("db-bahnpark");
    });

    it("merges freeSpaces from secondary when primary lacks it", () => {
      const db = makeFacility({
        id: "db-1",
        coordinates: [13.377, 52.52],
        sources: ["db-bahnpark"],
      });
      const osm = makeFacility({
        id: "osm-1",
        coordinates: [13.3772, 52.5202],
        sources: ["osm"],
        freeSpaces: 42,
      });
      const result = deduplicateParking([db, osm]);
      expect(result[0].freeSpaces).toBe(42);
    });

    it("real-time freeSpaces wins over a higher-priority static source", () => {
      // Primary has no realtime; secondary has realtime — secondary's count wins.
      const db = makeFacility({
        id: "db-1",
        coordinates: [13.377, 52.52],
        sources: ["db-bahnpark"],
        hasRealtimeData: false,
        freeSpaces: 10,
      });
      const osm = makeFacility({
        id: "osm-1",
        coordinates: [13.3772, 52.5202],
        sources: ["osm"],
        hasRealtimeData: true,
        freeSpaces: 42,
      });
      const result = deduplicateParking([db, osm]);
      expect(result[0].freeSpaces).toBe(42);
      expect(result[0].hasRealtimeData).toBe(true);
    });

    it("real-time state wins when primary has no real-time data", () => {
      const db = makeFacility({
        id: "db-1",
        coordinates: [13.377, 52.52],
        sources: ["db-bahnpark"],
        hasRealtimeData: false,
        state: "unknown",
      });
      const osm = makeFacility({
        id: "osm-1",
        coordinates: [13.3772, 52.5202],
        sources: ["osm"],
        hasRealtimeData: true,
        state: "open",
      });
      const result = deduplicateParking([db, osm]);
      expect(result[0].state).toBe("open");
    });

    it("primary freeSpaces wins when both sides are static", () => {
      const db = makeFacility({
        id: "db-1",
        coordinates: [13.377, 52.52],
        sources: ["db-bahnpark"],
        freeSpaces: 10,
      });
      const osm = makeFacility({
        id: "osm-1",
        coordinates: [13.3772, 52.5202],
        sources: ["osm"],
        freeSpaces: 42,
      });
      const result = deduplicateParking([db, osm]);
      expect(result[0].freeSpaces).toBe(10);
    });

    it("merges capacity from secondary when primary lacks it", () => {
      const db = makeFacility({
        id: "db-1",
        coordinates: [13.377, 52.52],
        sources: ["db-bahnpark"],
      });
      const osm = makeFacility({
        id: "osm-1",
        coordinates: [13.3772, 52.5202],
        sources: ["osm"],
        capacity: 200,
      });
      const result = deduplicateParking([db, osm]);
      expect(result[0].capacity).toBe(200);
    });

    it("hasRealtimeData is true if any member has it", () => {
      const db = makeFacility({
        id: "db-1",
        coordinates: [13.377, 52.52],
        sources: ["db-bahnpark"],
        hasRealtimeData: false,
      });
      const osm = makeFacility({
        id: "osm-1",
        coordinates: [13.3772, 52.5202],
        sources: ["osm"],
        hasRealtimeData: true,
      });
      const result = deduplicateParking([db, osm]);
      expect(result[0].hasRealtimeData).toBe(true);
    });

    it("hasRealtimeData is false if no member has it", () => {
      const db = makeFacility({
        id: "db-1",
        coordinates: [13.377, 52.52],
        sources: ["db-bahnpark"],
        hasRealtimeData: false,
      });
      const osm = makeFacility({
        id: "osm-1",
        coordinates: [13.3772, 52.5202],
        sources: ["osm"],
        hasRealtimeData: false,
      });
      const result = deduplicateParking([db, osm]);
      expect(result[0].hasRealtimeData).toBe(false);
    });

    it("parkingType: highest-priority non-unknown wins", () => {
      const db = makeFacility({
        id: "db-1",
        coordinates: [13.377, 52.52],
        sources: ["db-bahnpark"],
        parkingType: "unknown",
      });
      const osm = makeFacility({
        id: "osm-1",
        coordinates: [13.3772, 52.5202],
        sources: ["osm"],
        parkingType: "underground",
      });
      const result = deduplicateParking([db, osm]);
      expect(result[0].parkingType).toBe("underground");
    });

    it("disabledSpaces: max wins (richer count beats sentinel)", () => {
      const v3 = makeFacility({
        id: "v3-1",
        coordinates: [13.377, 52.52],
        sources: ["parkapi-v3"],
        disabledSpaces: 1,
      });
      const nrw = makeFacility({
        id: "nrw-1",
        coordinates: [13.3772, 52.5202],
        sources: ["nrw-mobidrom-parking"],
        disabledSpaces: 12,
      });
      const result = deduplicateParking([v3, nrw]);
      expect(result[0].disabledSpaces).toBe(12);
    });

    it("maxHeight: most restrictive (minimum) wins", () => {
      const a = makeFacility({
        id: "a",
        coordinates: [13.377, 52.52],
        sources: ["db-bahnpark"],
        maxHeight: 220,
      });
      const b = makeFacility({
        id: "b",
        coordinates: [13.3772, 52.5202],
        sources: ["osm"],
        maxHeight: 200,
      });
      const result = deduplicateParking([a, b]);
      expect(result[0].maxHeight).toBe(200);
    });

    it("address: richest (longest) string wins", () => {
      const db = makeFacility({
        id: "db-1",
        coordinates: [13.377, 52.52],
        sources: ["db-bahnpark"],
        address: "Hauptstr.",
      });
      const osm = makeFacility({
        id: "osm-1",
        coordinates: [13.3772, 52.5202],
        sources: ["osm"],
        address: "Hauptstraße 123, 10115 Berlin",
      });
      const result = deduplicateParking([db, osm]);
      expect(result[0].address).toBe("Hauptstraße 123, 10115 Berlin");
    });

    it("openingHours: richest string wins", () => {
      const a = makeFacility({
        id: "a",
        coordinates: [13.377, 52.52],
        sources: ["db-bahnpark"],
        openingHours: "24/7",
      });
      const b = makeFacility({
        id: "b",
        coordinates: [13.3772, 52.5202],
        sources: ["osm"],
        openingHours: "Mo-Fr 06:00-22:00; Sa 08:00-20:00; Su closed",
      });
      const result = deduplicateParking([a, b]);
      expect(result[0].openingHours).toContain("Mo-Fr");
    });

    it("parkAndRide: any true becomes true", () => {
      const a = makeFacility({
        id: "a",
        coordinates: [13.377, 52.52],
        sources: ["db-bahnpark"],
      });
      const b = makeFacility({
        id: "b",
        coordinates: [13.3772, 52.5202],
        sources: ["osm"],
        parkAndRide: true,
      });
      const result = deduplicateParking([a, b]);
      expect(result[0].parkAndRide).toBe(true);
    });

    it("sources: deduplicated per provider prefix, primary's full label kept", () => {
      const v2 = makeFacility({
        id: "v2-1",
        coordinates: [13.377, 52.52],
        sources: ["parkapi-v2/Dresden"],
      });
      const osm = makeFacility({
        id: "osm-1",
        coordinates: [13.3772, 52.5202],
        sources: ["osm"],
      });
      const result = deduplicateParking([v2, osm]);
      expect(result[0].sources).toEqual(["parkapi-v2/Dresden", "osm"]);
    });

    it("merges provenance, freshness, and quality metadata", () => {
      const v3 = makeFacility({
        id: "v3-1",
        coordinates: [13.377, 52.52],
        sources: ["parkapi-v3"],
        dataUpdatedAt: "2026-05-06T10:00:00.000Z",
        qualityWarnings: ["Realtime availability is older than 30 minutes."],
        sourceAttribution: { contributor: "MobiData BW", license: "dl-de/by-2-0" },
        sourceName: "MobiData BW",
        sourceUid: "bw",
      });
      const cita = makeFacility({
        id: "cita-lu:P1",
        coordinates: [13.3772, 52.5202],
        sources: ["cita-lu"],
        dataUpdatedAt: "2026-05-06T11:00:00.000Z",
        isStale: true,
        qualityWarnings: ["Realtime free-space count exceeded capacity and was clamped."],
        realtimeDataUpdatedAt: "2026-05-06T11:00:00.000Z",
      });

      const result = deduplicateParking([cita, v3]);

      expect(result[0].id).toBe("v3-1");
      expect(result[0].dataUpdatedAt).toBe("2026-05-06T11:00:00.000Z");
      expect(result[0].isStale).toBe(true);
      expect(result[0].qualityWarnings).toEqual([
        "Realtime availability is older than 30 minutes.",
        "Realtime free-space count exceeded capacity and was clamped.",
      ]);
      expect(result[0].sourceAttribution).toEqual({
        contributor: "MobiData BW",
        license: "dl-de/by-2-0",
      });
      expect(result[0].sourceName).toBe("MobiData BW");
      expect(result[0].sourceUid).toBe("bw");
    });

    it("enriches optional fields from lower-priority members when primary lacks them", () => {
      const db = makeFacility({
        id: "db-1",
        coordinates: [13.377, 52.52],
        sources: ["db-bahnpark"],
      });
      const osm = makeFacility({
        id: "osm-1",
        coordinates: [13.3772, 52.5202],
        sources: ["osm"],
        disabledSpaces: 5,
        chargingSpaces: 3,
        maxHeight: 200,
        fee: "paid",
        feeDescription: "2 EUR/h",
        access: "public",
        operator: "Parkhaus GmbH",
        address: "Hauptstraße 1",
        openingHours: "24/7",
        parkAndRide: true,
        nearestStation: "Berlin Hbf",
        chargingDetails: "22kW AC",
        paymentMethods: "Card, Cash",
        url: "https://example.com",
      });
      const result = deduplicateParking([db, osm]);
      expect(result[0].disabledSpaces).toBe(5);
      expect(result[0].chargingSpaces).toBe(3);
      expect(result[0].maxHeight).toBe(200);
      expect(result[0].fee).toBe("paid");
      expect(result[0].feeDescription).toBe("2 EUR/h");
      expect(result[0].access).toBe("public");
      expect(result[0].operator).toBe("Parkhaus GmbH");
      expect(result[0].address).toBe("Hauptstraße 1");
      expect(result[0].openingHours).toBe("24/7");
      expect(result[0].parkAndRide).toBe(true);
      expect(result[0].nearestStation).toBe("Berlin Hbf");
      expect(result[0].chargingDetails).toBe("22kW AC");
      expect(result[0].paymentMethods).toBe("Card, Cash");
      expect(result[0].url).toBe("https://example.com");
    });

    it("fee: highest-priority non-unknown wins", () => {
      const db = makeFacility({
        id: "db-1",
        coordinates: [13.377, 52.52],
        sources: ["db-bahnpark"],
        fee: "free",
      });
      const osm = makeFacility({
        id: "osm-1",
        coordinates: [13.3772, 52.5202],
        sources: ["osm"],
        fee: "paid",
      });
      const result = deduplicateParking([db, osm]);
      expect(result[0].fee).toBe("free");
    });

    it("fee: falls back when primary is unknown", () => {
      const db = makeFacility({
        id: "db-1",
        coordinates: [13.377, 52.52],
        sources: ["db-bahnpark"],
        fee: "unknown",
      });
      const osm = makeFacility({
        id: "osm-1",
        coordinates: [13.3772, 52.5202],
        sources: ["osm"],
        fee: "paid",
      });
      const result = deduplicateParking([db, osm]);
      expect(result[0].fee).toBe("paid");
    });
  });

  describe("groupwise merge (3+ members)", () => {
    it("highest priority across a cluster becomes primary", () => {
      const osm = makeFacility({
        id: "osm-1",
        coordinates: [13.377, 52.52],
        sources: ["osm"],
        name: "OSM Lot",
        capacity: 100,
      });
      const v3 = makeFacility({
        id: "pv3-1",
        coordinates: [13.3772, 52.5202],
        sources: ["parkapi-v3"],
        name: "V3 Lot",
        freeSpaces: 25,
        hasRealtimeData: true,
      });
      const db = makeFacility({
        id: "db-1",
        coordinates: [13.3771, 52.5201],
        sources: ["db-bahnpark"],
        name: "DB Lot",
        state: "open",
      });
      const result = deduplicateParking([osm, v3, db]);
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("db-1");
      expect(result[0].name).toBe("DB Lot");
      expect(result[0].sources[0]).toBe("db-bahnpark");
      // Groupwise merge still enriches from all lower-priority members
      expect(result[0].capacity).toBe(100);
      expect(result[0].freeSpaces).toBe(25);
      expect(result[0].hasRealtimeData).toBe(true);
      expect(result[0].state).toBe("open");
    });

    it("groupwise merge sees all members at once (not pairwise)", () => {
      // Three members, each has one unique field. A pairwise merge could
      // lose the third's field depending on iteration order; groupwise wins.
      const a = makeFacility({
        id: "a",
        coordinates: [13.377, 52.52],
        sources: ["osm"],
        capacity: 200,
      });
      const b = makeFacility({
        id: "b",
        coordinates: [13.3772, 52.5202],
        sources: ["osm"],
        disabledSpaces: 5,
      });
      const c = makeFacility({
        id: "c",
        coordinates: [13.3771, 52.5201],
        sources: ["osm"],
        chargingSpaces: 3,
      });
      const result = deduplicateParking([a, b, c]);
      expect(result).toHaveLength(1);
      expect(result[0].capacity).toBe(200);
      expect(result[0].disabledSpaces).toBe(5);
      expect(result[0].chargingSpaces).toBe(3);
    });
  });
});

describe("haversineMeters", () => {
  it("returns 0 for identical points", () => {
    expect(haversineMeters([13.377, 52.52], [13.377, 52.52])).toBe(0);
  });

  it("returns reasonable distance for Berlin–Munich (~504 km)", () => {
    const d = haversineMeters([13.405, 52.52], [11.582, 48.135]);
    expect(d).toBeGreaterThan(490_000);
    expect(d).toBeLessThan(520_000);
  });

  it("returns ~22m for a 0.0002° latitude step near 52°N", () => {
    const d = haversineMeters([13.377, 52.52], [13.377, 52.5202]);
    expect(d).toBeGreaterThan(15);
    expect(d).toBeLessThan(30);
  });
});
