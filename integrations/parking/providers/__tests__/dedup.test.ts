import { afterEach, describe, expect, it, vi } from "vitest";
import { deduplicateParking } from "../dedup.js";
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
    const f = makeFacility({ id: "p1", coordinates: [13.377, 52.52], sources: ["osm-parking"] });
    const result = deduplicateParking([f]);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("p1");
  });

  it("deduplicates two facilities in the same 3dp grid cell (~111m)", () => {
    const a = makeFacility({
      id: "db-1",
      coordinates: [13.3771, 52.5201],
      sources: ["db-bahnpark"],
      name: "DB Parking",
    });
    const b = makeFacility({
      id: "osm-1",
      coordinates: [13.3774, 52.5204],
      sources: ["osm-parking"],
      name: "OSM Parking",
    });
    // Both round to key: 52520,13377
    const result = deduplicateParking([a, b]);
    expect(result).toHaveLength(1);
  });

  it("keeps facilities in different grid cells", () => {
    const a = makeFacility({
      id: "p1",
      coordinates: [13.377, 52.52],
      sources: ["osm-parking"],
    });
    const b = makeFacility({
      id: "p2",
      coordinates: [13.39, 52.54],
      sources: ["osm-parking"],
    });
    const result = deduplicateParking([a, b]);
    expect(result).toHaveLength(2);
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
        coordinates: [13.3774, 52.5204],
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
        coordinates: [13.3774, 52.5204],
        sources: ["parkapi-v2/Dresden"],
        name: "V2 Parking",
      });
      const result = deduplicateParking([v2, v3]);
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("pv3-1");
      expect(result[0].sources[0]).toBe("parkapi-v3");
    });

    it("parkapi-v2 (2) wins over osm-parking (3)", () => {
      const v2 = makeFacility({
        id: "pv2-1",
        coordinates: [13.377, 52.52],
        sources: ["parkapi-v2/Berlin"],
        name: "V2 Parking",
      });
      const osm = makeFacility({
        id: "osm-1",
        coordinates: [13.3774, 52.5204],
        sources: ["osm-parking"],
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
        name: "Dresden P+R",
      });
      const osm = makeFacility({
        id: "osm-1",
        coordinates: [13.3774, 52.5204],
        sources: ["osm-parking"],
        name: "OSM Lot",
      });
      const result = deduplicateParking([osm, v2]);
      expect(result).toHaveLength(1);
      // parkapi-v2/Dresden (priority 2) beats osm-parking (priority 3)
      expect(result[0].id).toBe("pv2-1");
    });

    it("unknown source gets priority 99", () => {
      const unknown = makeFacility({
        id: "unk-1",
        coordinates: [13.377, 52.52],
        sources: ["some-new-provider"],
        name: "Unknown Lot",
      });
      const osm = makeFacility({
        id: "osm-1",
        coordinates: [13.3774, 52.5204],
        sources: ["osm-parking"],
        name: "OSM Lot",
      });
      const result = deduplicateParking([unknown, osm]);
      expect(result).toHaveLength(1);
      // osm-parking (priority 3) beats unknown (priority 99)
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
        coordinates: [13.3774, 52.5204],
        sources: ["osm-parking"],
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
        coordinates: [13.3774, 52.5204],
        sources: ["osm-parking"],
        freeSpaces: 42,
      });
      const result = deduplicateParking([db, osm]);
      expect(result[0].freeSpaces).toBe(42);
    });

    it("primary freeSpaces wins over secondary", () => {
      const db = makeFacility({
        id: "db-1",
        coordinates: [13.377, 52.52],
        sources: ["db-bahnpark"],
        freeSpaces: 10,
      });
      const osm = makeFacility({
        id: "osm-1",
        coordinates: [13.3774, 52.5204],
        sources: ["osm-parking"],
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
        coordinates: [13.3774, 52.5204],
        sources: ["osm-parking"],
        capacity: 200,
      });
      const result = deduplicateParking([db, osm]);
      expect(result[0].capacity).toBe(200);
    });

    it("hasRealtimeData is true if either source has it", () => {
      const db = makeFacility({
        id: "db-1",
        coordinates: [13.377, 52.52],
        sources: ["db-bahnpark"],
        hasRealtimeData: false,
      });
      const osm = makeFacility({
        id: "osm-1",
        coordinates: [13.3774, 52.5204],
        sources: ["osm-parking"],
        hasRealtimeData: true,
      });
      const result = deduplicateParking([db, osm]);
      expect(result[0].hasRealtimeData).toBe(true);
    });

    it("hasRealtimeData is false if neither source has it", () => {
      const db = makeFacility({
        id: "db-1",
        coordinates: [13.377, 52.52],
        sources: ["db-bahnpark"],
        hasRealtimeData: false,
      });
      const osm = makeFacility({
        id: "osm-1",
        coordinates: [13.3774, 52.5204],
        sources: ["osm-parking"],
        hasRealtimeData: false,
      });
      const result = deduplicateParking([db, osm]);
      expect(result[0].hasRealtimeData).toBe(false);
    });

    it("state: primary wins when not 'unknown'", () => {
      const db = makeFacility({
        id: "db-1",
        coordinates: [13.377, 52.52],
        sources: ["db-bahnpark"],
        state: "open",
      });
      const osm = makeFacility({
        id: "osm-1",
        coordinates: [13.3774, 52.5204],
        sources: ["osm-parking"],
        state: "closed",
      });
      const result = deduplicateParking([db, osm]);
      expect(result[0].state).toBe("open");
    });

    it("state: falls back to secondary when primary is 'unknown'", () => {
      const db = makeFacility({
        id: "db-1",
        coordinates: [13.377, 52.52],
        sources: ["db-bahnpark"],
        state: "unknown",
      });
      const osm = makeFacility({
        id: "osm-1",
        coordinates: [13.3774, 52.5204],
        sources: ["osm-parking"],
        state: "closed",
      });
      const result = deduplicateParking([db, osm]);
      expect(result[0].state).toBe("closed");
    });

    it("state: keeps primary 'unknown' when secondary has no state", () => {
      const db = makeFacility({
        id: "db-1",
        coordinates: [13.377, 52.52],
        sources: ["db-bahnpark"],
        state: "unknown",
      });
      const osm = makeFacility({
        id: "osm-1",
        coordinates: [13.3774, 52.5204],
        sources: ["osm-parking"],
      });
      const result = deduplicateParking([db, osm]);
      expect(result[0].state).toBe("unknown");
    });

    it("parkingType: primary wins when not 'unknown'", () => {
      const db = makeFacility({
        id: "db-1",
        coordinates: [13.377, 52.52],
        sources: ["db-bahnpark"],
        parkingType: "garage",
      });
      const osm = makeFacility({
        id: "osm-1",
        coordinates: [13.3774, 52.5204],
        sources: ["osm-parking"],
        parkingType: "surface",
      });
      const result = deduplicateParking([db, osm]);
      expect(result[0].parkingType).toBe("garage");
    });

    it("parkingType: falls back to secondary when primary is 'unknown'", () => {
      const db = makeFacility({
        id: "db-1",
        coordinates: [13.377, 52.52],
        sources: ["db-bahnpark"],
        parkingType: "unknown",
      });
      const osm = makeFacility({
        id: "osm-1",
        coordinates: [13.3774, 52.5204],
        sources: ["osm-parking"],
        parkingType: "underground",
      });
      const result = deduplicateParking([db, osm]);
      expect(result[0].parkingType).toBe("underground");
    });

    it("enriches optional fields from secondary when primary lacks them", () => {
      const db = makeFacility({
        id: "db-1",
        coordinates: [13.377, 52.52],
        sources: ["db-bahnpark"],
      });
      const osm = makeFacility({
        id: "osm-1",
        coordinates: [13.3774, 52.5204],
        sources: ["osm-parking"],
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

    it("fee: primary wins when not 'unknown'", () => {
      const db = makeFacility({
        id: "db-1",
        coordinates: [13.377, 52.52],
        sources: ["db-bahnpark"],
        fee: "free",
      });
      const osm = makeFacility({
        id: "osm-1",
        coordinates: [13.3774, 52.5204],
        sources: ["osm-parking"],
        fee: "paid",
      });
      const result = deduplicateParking([db, osm]);
      expect(result[0].fee).toBe("free");
    });

    it("fee: falls back to secondary when primary is 'unknown'", () => {
      const db = makeFacility({
        id: "db-1",
        coordinates: [13.377, 52.52],
        sources: ["db-bahnpark"],
        fee: "unknown",
      });
      const osm = makeFacility({
        id: "osm-1",
        coordinates: [13.3774, 52.5204],
        sources: ["osm-parking"],
        fee: "paid",
      });
      const result = deduplicateParking([db, osm]);
      expect(result[0].fee).toBe("paid");
    });
  });

  describe("coordinate rounding at 3dp", () => {
    it("rounds coordinates to 3 decimal places for grid key", () => {
      // 52.5201 and 52.5204 both round to 52520 at 3dp
      const a = makeFacility({
        id: "a",
        coordinates: [13.3771, 52.5201],
        sources: ["osm-parking"],
      });
      const b = makeFacility({
        id: "b",
        coordinates: [13.3774, 52.5204],
        sources: ["osm-parking"],
      });
      const result = deduplicateParking([a, b]);
      expect(result).toHaveLength(1);
    });

    it("separates coordinates in different 3dp cells", () => {
      // 52.5204 → round(52520.4) = 52520
      // 52.5206 → round(52520.6) = 52521  different cell
      const a = makeFacility({
        id: "a",
        coordinates: [13.377, 52.5204],
        sources: ["osm-parking"],
      });
      const b = makeFacility({
        id: "b",
        coordinates: [13.377, 52.5206],
        sources: ["osm-parking"],
      });
      const result = deduplicateParking([a, b]);
      expect(result).toHaveLength(2);
    });
  });

  it("handles three-way merge: highest priority becomes primary", () => {
    const osm = makeFacility({
      id: "osm-1",
      coordinates: [13.377, 52.52],
      sources: ["osm-parking"],
      name: "OSM Lot",
      capacity: 100,
    });
    const v3 = makeFacility({
      id: "pv3-1",
      coordinates: [13.3774, 52.5204],
      sources: ["parkapi-v3"],
      name: "V3 Lot",
      freeSpaces: 25,
    });
    const db = makeFacility({
      id: "db-1",
      coordinates: [13.3772, 52.5202],
      sources: ["db-bahnpark"],
      name: "DB Lot",
      state: "open",
    });
    // All three land in the same 3dp cell
    const result = deduplicateParking([osm, v3, db]);
    expect(result).toHaveLength(1);
    // db-bahnpark has highest priority (0), so it should be the primary
    expect(result[0].id).toBe("db-1");
    expect(result[0].name).toBe("DB Lot");
    expect(result[0].sources[0]).toBe("db-bahnpark");
    expect(result[0].state).toBe("open");
  });
});
