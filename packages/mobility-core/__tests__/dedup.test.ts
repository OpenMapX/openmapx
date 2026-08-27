import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@openmapx/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@openmapx/core")>();
  return { ...actual, haversineMeters: vi.fn(), diceSimilarity: vi.fn() };
});

import type { SharedMobilityStation } from "@openmapx/core";
import { diceSimilarity, haversineMeters } from "@openmapx/core";
import { dedupStations, dedupVehicles } from "../src/dedup.js";
import type { SharedMobilityVehicle } from "../src/types/shared-mobility.js";

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
    systemId: "shared-test-system",
    sources: ["citybikes/test"],
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

  it("deduplicates by exact coordinate match at 4dp and merges source attribution", () => {
    // Both will have the same coordKey via toFixed(4)
    const a = makeStation({
      id: "s1",
      name: "Station A",
      coordinates: [13.37700001, 52.52000001],
      sources: ["gbfs/lime"],
    });
    const b = makeStation({
      id: "s2",
      name: "Station B",
      coordinates: [13.37700002, 52.52000002],
      sources: ["gbfs/bolt"],
    });
    // haversineMeters should not even be called for exact coord match
    const result = dedupStations([a, b]);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("s1");
    expect(result[0].sources).toEqual(["gbfs/lime", "gbfs/bolt"]);
  });

  it("deduplicates when within 50m and name similarity > 0.6", () => {
    const a = makeStation({
      id: "s1",
      name: "Alexanderplatz Station",
      coordinates: [13.41, 52.521],
      sources: ["gbfs/lime"],
    });
    const b = makeStation({
      id: "s2",
      name: "Alexanderplatz Bikes",
      coordinates: [13.4103, 52.5213],
      sources: ["citybikes/nextbike"],
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
      sources: ["gbfs/lime"],
    });
    const b = makeStation({
      id: "s2",
      name: "Hauptbahnhof Parking",
      coordinates: [13.4103, 52.5213],
      sources: ["citybikes/nextbike"],
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
      sources: ["cambio-live"],
      availableVehicles: 5,
    });
    const secondary = makeStation({
      id: "open-1",
      name: "Cambio Station",
      coordinates: [13.4103, 52.5213],
      sources: ["open-data"],
      availableVehicles: 0,
    });

    mockHaversine.mockReturnValue(25); // within 50m
    mockDice.mockReturnValue(1.0); // identical name

    const result = dedupStations([primary, secondary]);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("live-1");
    expect(result[0].sources).toEqual(["cambio-live", "open-data"]);
    expect(result[0].availableVehicles).toBe(5);
  });

  it("fills missing station detail fields from later duplicate sources", () => {
    const primary = makeStation({
      id: "s1",
      name: "Station A",
      coordinates: [13.41, 52.521],
      sources: ["gbfs/test"],
      website: undefined,
      pricingSummary: undefined,
      rentalUris: undefined,
    });
    const enrichment = makeStation({
      id: "s2",
      name: "Station A",
      coordinates: [13.41001, 52.52101],
      sources: ["entur-mobility"],
      website: "https://operator.example",
      pricingSummary: "10.90 NOK + 150.00 NOK/h",
      rentalUris: { ios: "ios://example" },
      address: { city: "Oslo" },
    });

    const result = dedupStations([primary, enrichment]);

    expect(result).toHaveLength(1);
    expect(result[0].website).toBe("https://operator.example");
    expect(result[0].pricingSummary).toBe("10.90 NOK + 150.00 NOK/h");
    expect(result[0].rentalUris).toEqual({
      web: undefined,
      android: undefined,
      ios: "ios://example",
    });
    expect(result[0].address).toEqual({
      street: undefined,
      city: "Oslo",
      postcode: undefined,
      country: undefined,
    });
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

function makeVehicle(
  overrides: Partial<SharedMobilityVehicle> &
    Pick<SharedMobilityVehicle, "id" | "coordinates" | "sources">,
): SharedMobilityVehicle {
  return {
    formFactor: "scooter_standing",
    isReserved: false,
    isDisabled: false,
    systemId: "shared-test-system",
    ...overrides,
  };
}

function makeTransitousVehicle(
  nativeId: string,
  sources: string[] = ["transitous"],
): SharedMobilityVehicle {
  return makeVehicle({
    id: `transitous/shared-test-system/vehicle/${nativeId}`,
    nativeId,
    coordinates: [13.41, 52.52],
    sources,
    servingOrigin: "transitous",
  });
}

describe("dedupVehicles", () => {
  it("returns empty array for empty input", () => {
    expect(dedupVehicles([])).toEqual([]);
  });

  it("keeps a single direct-source vehicle", () => {
    const v = makeVehicle({
      id: "gbfs/dott-berlin/uuid-1",
      coordinates: [13.41, 52.52],
      sources: ["gbfs/dott-berlin"],
    });
    expect(dedupVehicles([v])).toHaveLength(1);
  });

  it("keeps a single aggregator vehicle when there is no direct-source counterpart", () => {
    const v = makeTransitousVehicle("uuid-1");
    expect(dedupVehicles([v])).toHaveLength(1);
  });

  it("merges sources when GBFS and Transitous share the same raw vehicle ID", () => {
    const gbfs = makeVehicle({
      id: "gbfs/dott-berlin/uuid-1",
      coordinates: [13.41, 52.52],
      sources: ["gbfs/dott-berlin"],
    });
    const transitous = makeTransitousVehicle("uuid-1");
    transitous.coordinates = [13.5, 52.6];
    // Coordinates deliberately differ — ID match is the only criterion

    const result = dedupVehicles([gbfs, transitous]);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("gbfs/dott-berlin/uuid-1");
    expect(result[0].sources).toEqual(["gbfs/dott-berlin", "transitous"]);
  });

  it("keeps both when raw IDs differ (genuinely different vehicles)", () => {
    const gbfs = makeVehicle({
      id: "gbfs/dott-berlin/uuid-1",
      coordinates: [13.41, 52.52],
      sources: ["gbfs/dott-berlin"],
    });
    const transitous = makeTransitousVehicle("uuid-2");

    const result = dedupVehicles([gbfs, transitous]);
    expect(result).toHaveLength(2);
  });

  it("never deduplicates two direct-source vehicles even if their raw IDs match", () => {
    // Same UUID appearing in two different GBFS systems would be unusual but must not be deduped
    const a = makeVehicle({
      id: "gbfs/dott-berlin/uuid-1",
      systemId: "dott-berlin",
      coordinates: [13.41, 52.52],
      sources: ["gbfs/dott-berlin"],
    });
    const b = makeVehicle({
      id: "gbfs/dott-aachen/uuid-1",
      systemId: "dott-aachen",
      coordinates: [13.41, 52.52],
      sources: ["gbfs/dott-aachen"],
    });

    const result = dedupVehicles([a, b]);
    expect(result).toHaveLength(2);
    expect(result.map((v) => v.id)).toEqual(["gbfs/dott-berlin/uuid-1", "gbfs/dott-aachen/uuid-1"]);
  });

  it("never merges identical native IDs from competing providers", () => {
    const direct = makeVehicle({
      id: "gbfs/operator-a/shared-id",
      nativeId: "shared-id",
      systemId: "operator-a",
      coordinates: [13.41, 52.52],
      sources: ["gbfs/operator-a"],
    });
    const aggregator = makeVehicle({
      id: "motis-local/operator-b/vehicle/shared-id",
      nativeId: "shared-id",
      systemId: "operator-b",
      servingOrigin: "motis-local",
      coordinates: [13.41, 52.52],
      sources: ["mobilitydata:operator-b"],
    });

    expect(dedupVehicles([direct, aggregator])).toHaveLength(2);
  });

  it("treats 'motis' source the same as 'transitous'", () => {
    const gbfs = makeVehicle({
      id: "gbfs/foo/uuid-1",
      coordinates: [13.41, 52.52],
      sources: ["gbfs/foo"],
    });
    const motis = makeTransitousVehicle("uuid-1", ["motis"]);

    const result = dedupVehicles([gbfs, motis]);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("gbfs/foo/uuid-1");
    expect(result[0].sources).toEqual(["gbfs/foo", "motis"]);
  });

  it("treats 'de-nw-mobidrom-scooter' as an aggregator source", () => {
    const gbfs = makeVehicle({
      id: "gbfs/voi-berlin/uuid-nrw-1",
      coordinates: [13.41, 52.52],
      sources: ["gbfs/voi-berlin"],
    });
    const nrw = makeVehicle({
      id: "de-nw-mobidrom-scooter/source-voi-dortmund/uuid-nrw-1",
      coordinates: [13.41, 52.52],
      sources: ["de-nw-mobidrom-scooter"],
    });

    const result = dedupVehicles([gbfs, nrw]);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("gbfs/voi-berlin/uuid-nrw-1");
    expect(result[0].sources).toEqual(["gbfs/voi-berlin", "de-nw-mobidrom-scooter"]);
  });

  it("keeps NRW Mobidrom vehicle when no direct-source counterpart exists", () => {
    const nrw = makeVehicle({
      id: "de-nw-mobidrom-scooter/source-lime-dortmund/uuid-nrw-only",
      coordinates: [7.47, 51.51],
      sources: ["de-nw-mobidrom-scooter"],
    });
    const result = dedupVehicles([nrw]);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("de-nw-mobidrom-scooter/source-lime-dortmund/uuid-nrw-only");
  });

  it("merges sources when two aggregator vehicles share a raw ID and no direct-source exists", () => {
    const mo1 = makeTransitousVehicle("uuid-1");
    const mo2 = makeTransitousVehicle("uuid-1", ["motis"]);

    const result = dedupVehicles([mo1, mo2]);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("transitous/shared-test-system/vehicle/uuid-1");
    expect(result[0].sources).toEqual(["transitous", "motis"]);
  });

  it("keeps non-duplicate aggregator vehicles alongside merged ones", () => {
    const gbfs = makeVehicle({
      id: "gbfs/dott/uuid-1",
      coordinates: [13.41, 52.52],
      sources: ["gbfs/dott"],
    });
    const mo1 = makeTransitousVehicle("uuid-1"); // matches gbfs
    const mo2 = makeTransitousVehicle("uuid-2"); // no match
    mo2.coordinates = [13.5, 52.6];

    const result = dedupVehicles([gbfs, mo1, mo2]);
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe("gbfs/dott/uuid-1");
    expect(result[0].sources).toEqual(["gbfs/dott", "transitous"]);
    expect(result[1].id).toBe("transitous/shared-test-system/vehicle/uuid-2");
    expect(result[1].sources).toEqual(["transitous"]);
  });

  it("falls back to extracting the last namespaced ID segment", () => {
    const a = makeVehicle({
      id: "gbfs/dott-berlin/2850b11e-abc",
      coordinates: [13.41, 52.52],
      sources: ["gbfs/dott-berlin"],
    });
    const b = makeVehicle({
      id: "transitous/shared-test-system/vehicle/2850b11e-abc",
      coordinates: [13.41, 52.52],
      sources: ["transitous"],
      servingOrigin: "transitous",
    });

    const result = dedupVehicles([a, b]);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("gbfs/dott-berlin/2850b11e-abc");
  });
});
