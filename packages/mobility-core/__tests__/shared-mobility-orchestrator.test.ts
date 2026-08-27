import { describe, expect, it, vi } from "vitest";
import {
  getSharedMobilityOperationsState,
  mergeMotisFirstInventory,
  orchestrateSharedMobility,
  resolveSharedMobilitySourcePolicy,
  setSharedMobilityRollback,
} from "../src/shared-mobility-orchestrator.js";
import type {
  MotisRentalSnapshot,
  SharedMobilityStation,
  SharedMobilityVehicle,
} from "../src/types/shared-mobility.js";

const bbox = { west: 10, south: 50, east: 11, north: 51 };

function station(overrides: Partial<SharedMobilityStation> = {}): SharedMobilityStation {
  return {
    id: "station",
    nativeId: "station-native",
    providerId: "provider",
    name: "Central",
    coordinates: [10.5, 50.5],
    availableVehicles: 2,
    vehicleTypes: ["bicycle"],
    isActive: true,
    isRenting: true,
    isReturning: true,
    sources: ["motis"],
    servingOrigin: "motis-local",
    ...overrides,
  };
}

function vehicle(overrides: Partial<SharedMobilityVehicle> = {}): SharedMobilityVehicle {
  return {
    id: "vehicle",
    nativeId: "vehicle-native",
    providerId: "provider",
    coordinates: [10.5, 50.5],
    formFactor: "bicycle",
    isReserved: false,
    isDisabled: false,
    sources: ["motis"],
    servingOrigin: "motis-local",
    ...overrides,
  };
}

function snapshot(overrides: Partial<MotisRentalSnapshot> = {}): MotisRentalSnapshot {
  return {
    origin: "motis-local",
    providers: [],
    providerGroups: [],
    stations: [station()],
    vehicles: [vehicle()],
    zones: [],
    completeness: {
      providers: true,
      providerGroups: true,
      stations: true,
      vehicles: true,
      zones: true,
      warnings: [],
    },
    ...overrides,
  };
}

describe("mergeMotisFirstInventory", () => {
  it("keeps MOTIS operational fields while filling approved metadata", () => {
    const merged = mergeMotisFirstInventory({ stations: [station()], vehicles: [vehicle()] }, [
      {
        stations: [
          station({
            coordinates: [1, 2],
            availableVehicles: 99,
            isRenting: false,
            address: { street: "Main 1" },
            pricingSummary: "€1",
            sources: ["direct"],
            servingOrigin: undefined,
          }),
        ],
        vehicles: [
          vehicle({
            coordinates: [1, 2],
            isDisabled: true,
            stationId: "wrong",
            batteryLevel: 80,
            rangeMeters: 12_000,
            sources: ["direct"],
            servingOrigin: undefined,
          }),
        ],
      },
    ]);
    expect(merged.stations[0]).toMatchObject({
      coordinates: [10.5, 50.5],
      availableVehicles: 2,
      isRenting: true,
      address: { street: "Main 1" },
      pricingSummary: "€1",
      sources: ["motis", "direct"],
    });
    expect(merged.vehicles[0]).toMatchObject({
      coordinates: [10.5, 50.5],
      isDisabled: false,
      batteryLevel: 80,
      rangeMeters: 12_000,
    });
  });

  it("does not merge the same native id across providers", () => {
    const merged = mergeMotisFirstInventory({ stations: [], vehicles: [vehicle()] }, [
      { stations: [], vehicles: [vehicle({ providerId: "competitor", id: "other" })] },
    ]);
    expect(merged.vehicles).toHaveLength(2);
  });
});

describe("orchestrateSharedMobility", () => {
  it("uses one local inventory call and skips direct fallbacks when complete", async () => {
    const fetchMotis = vi.fn().mockResolvedValue(snapshot());
    const fallback = vi.fn();
    const result = await orchestrateSharedMobility(bbox, {
      category: "bike",
      formFactors: new Set(["bicycle"]),
      motisFormFactors: ["bicycle"],
      policy: "motis-first",
      fetchMotis,
      adapters: [{ id: "direct-gbfs", kind: "fallback", fetch: fallback }],
    });
    expect(fetchMotis).toHaveBeenCalledTimes(1);
    expect(fallback).not.toHaveBeenCalled();
    expect(result.decision).toMatchObject({ local: "healthy", skippedAdapters: ["direct-gbfs"] });
  });

  it("treats healthy local empty inventory as authoritative", async () => {
    const fallback = vi.fn();
    await orchestrateSharedMobility(bbox, {
      category: "bike",
      formFactors: new Set(["bicycle"]),
      motisFormFactors: ["bicycle"],
      policy: "motis-first",
      fetchMotis: vi.fn().mockResolvedValue(snapshot({ stations: [], vehicles: [] })),
      adapters: [{ id: "direct-gbfs", kind: "fallback", fetch: fallback }],
    });
    expect(fallback).not.toHaveBeenCalled();
  });

  it("targets fallback on partial local capability and keeps proprietary adapters", async () => {
    const direct = vi.fn().mockResolvedValue({ stations: [], vehicles: [] });
    const proprietary = vi.fn().mockResolvedValue({ stations: [], vehicles: [] });
    const partial = snapshot();
    partial.completeness.vehicles = false;
    const result = await orchestrateSharedMobility(bbox, {
      category: "scooter",
      formFactors: new Set(["scooter_standing"]),
      motisFormFactors: ["scooter_standing"],
      policy: "motis-first",
      fetchMotis: vi.fn().mockResolvedValue(partial),
      adapters: [
        { id: "direct", kind: "fallback", fetch: direct },
        { id: "felyx", kind: "proprietary", fetch: proprietary },
      ],
    });
    expect(direct).toHaveBeenCalledTimes(1);
    expect(proprietary).toHaveBeenCalledTimes(1);
    expect(result.decision.partial).toBe(true);
  });

  it("restores fanout through the category denylist", async () => {
    const fallback = vi.fn().mockResolvedValue({ stations: [], vehicles: [] });
    const result = await orchestrateSharedMobility(bbox, {
      category: "car",
      formFactors: new Set(["car"]),
      motisFormFactors: ["car"],
      policy: "motis-first",
      denylist: new Set(["car"]),
      fetchMotis: vi.fn().mockResolvedValue(snapshot()),
      adapters: [{ id: "direct", kind: "fallback", fetch: fallback }],
    });
    expect(fallback).toHaveBeenCalled();
    expect(result.decision.policy).toBe("fanout");
  });

  it("publishes bounded decision state and supports immediate rollback", async () => {
    setSharedMobilityRollback("bike", true);
    await orchestrateSharedMobility(bbox, {
      category: "bike",
      formFactors: new Set(["bicycle"]),
      motisFormFactors: ["bicycle"],
      policy: "motis-first",
      fetchMotis: vi.fn().mockResolvedValue(snapshot()),
      adapters: [
        {
          id: "direct",
          kind: "fallback",
          fetch: vi.fn().mockResolvedValue({ stations: [], vehicles: [] }),
        },
      ],
    });

    const state = getSharedMobilityOperationsState();
    expect(state.rollbackCategories).toContain("bike");
    expect(state.decisions.find((record) => record.category === "bike")).toEqual({
      category: "bike",
      decision: {
        policy: "fanout",
        local: "healthy",
        served: "fanout",
        calledAdapters: ["direct"],
        skippedAdapters: [],
        partial: false,
      },
      recordedAt: expect.any(String),
    });
    const boundedDecisionKeys = new Set([
      "calledAdapters",
      "local",
      "partial",
      "policy",
      "served",
      "skippedAdapters",
      "stationDelta",
      "vehicleDelta",
    ]);
    for (const record of state.decisions) {
      expect(Object.keys(record).sort()).toEqual(["category", "decision", "recordedAt"]);
      expect(Object.keys(record.decision).every((key) => boundedDecisionKeys.has(key))).toBe(true);
    }
    setSharedMobilityRollback("bike", false);
  });
});

describe("resolveSharedMobilitySourcePolicy", () => {
  it("defaults to fanout so direct GBFS coverage is not suppressed by MOTIS", () => {
    expect(resolveSharedMobilitySourcePolicy(undefined)).toBe("fanout");
    expect(resolveSharedMobilitySourcePolicy("")).toBe("fanout");
    expect(resolveSharedMobilitySourcePolicy("not-a-policy")).toBe("fanout");
  });

  it("honours an explicit valid policy override", () => {
    expect(resolveSharedMobilitySourcePolicy("motis-first")).toBe("motis-first");
    expect(resolveSharedMobilitySourcePolicy("shadow")).toBe("shadow");
    expect(resolveSharedMobilitySourcePolicy("fanout")).toBe("fanout");
  });
});
