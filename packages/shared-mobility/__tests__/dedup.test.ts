import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../utils/geo.js", () => ({
  diceSimilarity: vi.fn(),
  haversineMeters: vi.fn(),
}));

import type { SharedMobilityStation } from "@openmapx/core";
import { diceSimilarity, haversineMeters } from "@openmapx/core";
import { dedupStations } from "../dedup.js";

const mockHaversine = vi.mocked(haversineMeters);
const mockDice = vi.mocked(diceSimilarity);

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function makeStation(
  overrides: Partial<SharedMobilityStation> &
    Pick<SharedMobilityStation, "id" | "name" | "coordinates">,
): SharedMobilityStation {
  return {
    availableVehicles: 3,
    vehicleTypes: ["bicycle"],
    isActive: true,
    source: "citybikes/test",
    ...overrides,
  };
}

describe("dedupStations", () => {
  it("returns empty array for empty input", () => {
    expect(dedupStations([])).toEqual([]);
  });

  it("returns single station as-is", () => {
    const station = makeStation({
      id: "s1",
      name: "Station A",
      coordinates: [13.377, 52.52],
    });
    const result = dedupStations([station]);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("s1");
    expect(result[0].name).toBe("Station A");
  });

  it("deduplicates by exact coordinate match at 4dp (first-seen wins)", () => {
    // Both will have the same coordKey via toFixed(4)
    const a = makeStation({
      id: "s1",
      name: "Station A",
      coordinates: [13.37700001, 52.52000001],
      source: "gbfs/lime",
    });
    const b = makeStation({
      id: "s2",
      name: "Station B",
      coordinates: [13.37700002, 52.52000002],
      source: "gbfs/bolt",
    });
    // haversineMeters should not even be called for exact coord match
    const result = dedupStations([a, b]);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("s1");
    expect(result[0].source).toBe("gbfs/lime");
  });

  it("deduplicates when within 50m and name similarity > 0.6", () => {
    const a = makeStation({
      id: "s1",
      name: "Alexanderplatz Station",
      coordinates: [13.41, 52.521],
      source: "gbfs/lime",
    });
    const b = makeStation({
      id: "s2",
      name: "Alexanderplatz Bikes",
      coordinates: [13.4103, 52.5213],
      source: "citybikes/nextbike",
    });

    // Different 4dp keys, so fuzzy check runs
    mockHaversine.mockReturnValue(30); // within 50m
    mockDice.mockReturnValue(0.7); // > 0.6

    const result = dedupStations([a, b]);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("s1");
  });

  it("keeps both when within 50m but name similarity <= 0.6", () => {
    const a = makeStation({
      id: "s1",
      name: "Lime Bikes Central",
      coordinates: [13.41, 52.521],
      source: "gbfs/lime",
    });
    const b = makeStation({
      id: "s2",
      name: "Hauptbahnhof Parking",
      coordinates: [13.4103, 52.5213],
      source: "citybikes/nextbike",
    });

    mockHaversine.mockReturnValue(30); // within 50m
    mockDice.mockReturnValue(0.3); // <= 0.6

    const result = dedupStations([a, b]);
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe("s1");
    expect(result[1].id).toBe("s2");
  });

  it("keeps both when > 50m apart regardless of name similarity", () => {
    const a = makeStation({
      id: "s1",
      name: "Station Alpha",
      coordinates: [13.41, 52.521],
    });
    const b = makeStation({
      id: "s2",
      name: "Station Alpha",
      coordinates: [13.42, 52.531],
    });

    mockHaversine.mockReturnValue(200); // > 50m

    const result = dedupStations([a, b]);
    expect(result).toHaveLength(2);
  });

  it("input order is priority order — first wins", () => {
    const primary = makeStation({
      id: "live-1",
      name: "Cambio Station",
      coordinates: [13.41, 52.521],
      source: "cambio-live",
      availableVehicles: 5,
    });
    const secondary = makeStation({
      id: "open-1",
      name: "Cambio Station",
      coordinates: [13.4103, 52.5213],
      source: "open-data",
      availableVehicles: 0,
    });

    mockHaversine.mockReturnValue(25); // within 50m
    mockDice.mockReturnValue(1.0); // identical name

    const result = dedupStations([primary, secondary]);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("live-1");
    expect(result[0].source).toBe("cambio-live");
    expect(result[0].availableVehicles).toBe(5);
  });

  it("handles a mix of exact matches, fuzzy matches, and distinct stations", () => {
    const s1 = makeStation({
      id: "s1",
      name: "Station One",
      coordinates: [13.41, 52.521],
    });
    const s1dup = makeStation({
      id: "s1-dup",
      name: "Station One Copy",
      // Same 4dp key as s1
      coordinates: [13.41000001, 52.52100001],
    });
    const s2 = makeStation({
      id: "s2",
      name: "Station Two",
      coordinates: [13.42, 52.53],
    });
    const s2fuzzy = makeStation({
      id: "s2-fuzzy",
      name: "Station Two Nearby",
      coordinates: [13.4203, 52.5303],
    });
    const s3 = makeStation({
      id: "s3",
      name: "Station Three",
      coordinates: [14.0, 51.0],
    });

    // s2fuzzy vs s1 → far apart
    // s2fuzzy vs s2 → close + similar name
    mockHaversine.mockImplementation((lat1, _lng1, lat2, _lng2) => {
      // s2fuzzy checking against s1
      if (lat1 === 52.5303 && lat2 === 52.521) return 1200;
      // s2fuzzy checking against s2
      if (lat1 === 52.5303 && lat2 === 52.53) return 40;
      return 9999;
    });
    mockDice.mockReturnValue(0.8);

    const result = dedupStations([s1, s1dup, s2, s2fuzzy, s3]);
    expect(result).toHaveLength(3);
    expect(result.map((s) => s.id)).toEqual(["s1", "s2", "s3"]);
  });

  it("passes lowercase trimmed names to diceSimilarity", () => {
    const a = makeStation({
      id: "s1",
      name: "  Station Alpha  ",
      coordinates: [13.41, 52.521],
    });
    const b = makeStation({
      id: "s2",
      name: "  Station ALPHA  ",
      coordinates: [13.4103, 52.5213],
    });

    mockHaversine.mockReturnValue(30);
    mockDice.mockReturnValue(1.0);

    dedupStations([a, b]);
    expect(mockDice).toHaveBeenCalledWith("station alpha", "station alpha");
  });

  it("passes lat/lng in correct order to haversineMeters (lat1, lng1, lat2, lng2)", () => {
    const a = makeStation({
      id: "s1",
      name: "A",
      coordinates: [13.41, 52.52],
    });
    const b = makeStation({
      id: "s2",
      name: "B",
      coordinates: [13.42, 52.53],
    });

    mockHaversine.mockReturnValue(200);

    dedupStations([a, b]);
    // Source code calls haversineMeters(s.coordinates[1], s.coordinates[0], existing.coordinates[1], existing.coordinates[0])
    // b is the new station (s), a is existing
    expect(mockHaversine).toHaveBeenCalledWith(52.53, 13.42, 52.52, 13.41);
  });
});
