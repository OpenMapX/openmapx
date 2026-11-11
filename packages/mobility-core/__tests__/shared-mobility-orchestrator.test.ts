import { describe, expect, it, vi } from "vitest";
import {
  getSharedMobilityOperationsState,
  mergeMotisFirstInventory,
  orchestrateSharedMobility,
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
  it("queries MOTIS and every adapter even when the local inventory is complete", async () => {
    const fetchMotis = vi.fn().mockResolvedValue(snapshot());
    const direct = vi.fn().mockResolvedValue({ stations: [], vehicles: [] });
    const proprietary = vi.fn().mockResolvedValue({ stations: [], vehicles: [] });
    const result = await orchestrateSharedMobility(bbox, {
      category: "bike",
      motisFormFactors: ["bicycle"],
      fetchMotis,
      adapters: [
        { id: "direct-gbfs", fetch: direct },
        { id: "felyx", fetch: proprietary },
      ],
    });
    expect(fetchMotis).toHaveBeenCalledTimes(1);
    expect(direct).toHaveBeenCalledTimes(1);
    expect(proprietary).toHaveBeenCalledTimes(1);
    expect(result.decision).toEqual({
      local: "healthy",
      calledAdapters: ["direct-gbfs", "felyx"],
      partial: false,
    });
  });

  it("adds direct inventory to an empty but complete local result", async () => {
    const direct = vi
      .fn()
      .mockResolvedValue({ stations: [station({ id: "direct" })], vehicles: [] });
    const result = await orchestrateSharedMobility(bbox, {
      category: "bike",
      motisFormFactors: ["bicycle"],
      fetchMotis: vi.fn().mockResolvedValue(snapshot({ stations: [], vehicles: [] })),
      adapters: [{ id: "direct-gbfs", fetch: direct }],
    });
    expect(direct).toHaveBeenCalledTimes(1);
    expect(result.stations.map((entry) => entry.id)).toEqual(["direct"]);
  });

  it("marks a partial local capability and still queries every adapter", async () => {
    const direct = vi.fn().mockResolvedValue({ stations: [], vehicles: [] });
    const proprietary = vi.fn().mockResolvedValue({ stations: [], vehicles: [] });
    const partial = snapshot();
    partial.completeness.vehicles = false;
    const result = await orchestrateSharedMobility(bbox, {
      category: "scooter",
      motisFormFactors: ["scooter_standing"],
      fetchMotis: vi.fn().mockResolvedValue(partial),
      adapters: [
        { id: "direct", fetch: direct },
        { id: "felyx", fetch: proprietary },
      ],
    });
    expect(direct).toHaveBeenCalledTimes(1);
    expect(proprietary).toHaveBeenCalledTimes(1);
    expect(result.decision).toMatchObject({ local: "partial", partial: true });
  });

  it("publishes bounded decision state per category", async () => {
    await orchestrateSharedMobility(bbox, {
      category: "bike",
      motisFormFactors: ["bicycle"],
      fetchMotis: vi.fn().mockResolvedValue(snapshot()),
      adapters: [
        {
          id: "direct",
          fetch: vi.fn().mockResolvedValue({ stations: [], vehicles: [] }),
        },
      ],
    });

    const state = getSharedMobilityOperationsState();
    expect(Object.keys(state)).toEqual(["decisions"]);
    expect(state.decisions.find((record) => record.category === "bike")).toEqual({
      category: "bike",
      decision: { local: "healthy", calledAdapters: ["direct"], partial: false },
      recordedAt: expect.any(String),
    });
    for (const record of state.decisions) {
      expect(Object.keys(record).sort()).toEqual(["category", "decision", "recordedAt"]);
      expect(Object.keys(record.decision).sort()).toEqual(["calledAdapters", "local", "partial"]);
    }
  });
});

it("keeps duplicate no-op supplements uncredited but credits retained gap fills", () => {
  const a = { sourceId: "a", name: "A" };
  const b = { sourceId: "b", name: "B" };
  const primary = station({
    sources: ["a"],
    contributors: [a],
    address: { street: "Known" },
    capacity: 10,
    branding: { name: "Known" },
    rentalApps: {},
    rentalUris: {},
    website: "https://a.example",
    vehicleTypeDetails: [],
    vehicleClassNames: [],
    pricingSummary: "Known",
    pricingDetails: [],
    crossStreet: "Known",
  });
  const duplicate = {
    ...structuredClone(primary),
    sources: ["b"],
    contributors: [b],
    availableVehicles: 99,
  };
  const noOp = mergeMotisFirstInventory({ stations: [primary], vehicles: [] }, [
    { stations: [duplicate], vehicles: [] },
  ]);
  expect(noOp.stations[0].sources).toEqual(["a"]);
  expect(noOp.stations[0].contributors).toEqual([a]);
  const gap = station({ sources: ["a"], contributors: [a] });
  const filled = mergeMotisFirstInventory({ stations: [gap], vehicles: [] }, [
    { stations: [duplicate], vehicles: [] },
  ]);
  expect(filled.stations[0].address).toEqual({ street: "Known" });
  expect(filled.stations[0].contributors).toEqual([a, b]);
});
