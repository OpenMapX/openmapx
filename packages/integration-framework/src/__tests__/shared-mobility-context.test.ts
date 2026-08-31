import type { SharedMobilityRuntime } from "@openmapx/mobility-core/shared-mobility-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { fetchMotisRentals, buildEnturGeofencingMapContext } = vi.hoisted(() => ({
  fetchMotisRentals: vi.fn(),
  buildEnturGeofencingMapContext: vi.fn(),
}));

import { buildSharedMobilityMapContext } from "../shared-mobility/context.js";

const runtime = {
  fetchMotisRentals,
  buildEnturGeofencingMapContext,
} as unknown as SharedMobilityRuntime;

const bbox = { west: 0, south: 0, east: 10, north: 10 };
const area = {
  type: "MultiPolygon" as const,
  coordinates: [
    [
      [
        [1, 1],
        [9, 1],
        [9, 9],
        [1, 9],
        [1, 1],
      ],
    ],
  ],
};

function snapshot() {
  return {
    origin: "motis-local",
    providers: [
      {
        id: "provider-stable",
        nativeId: "provider-native",
        name: "Example Mobility",
        groupId: "group-stable",
        bbox: [0, 0, 10, 10],
        formFactors: ["bicycle"],
        vehicleTypes: [],
        defaultRestrictions: {
          vehicleTypeIds: [],
          rideStartAllowed: true,
          rideEndAllowed: true,
          rideThroughAllowed: true,
        },
        globalRestrictions: [],
        sourceId: "gbfs/example",
        servingOrigin: "motis-local",
      },
    ],
    providerGroups: [
      {
        id: "group-stable",
        nativeId: "group-native",
        name: "Example Group",
        providerIds: ["provider-stable"],
        formFactors: ["bicycle"],
      },
    ],
    stations: [
      {
        id: "station-stable",
        name: "Central Station",
        coordinates: [5, 5],
        availableVehicles: 2,
        vehicleTypes: ["bicycle"],
        vehicleTypeIds: ["type-bike"],
        providerId: "provider-stable",
        providerGroupId: "group-stable",
        isActive: true,
        isRenting: true,
        isReturning: true,
        sources: ["gbfs/example"],
        stationArea: area,
      },
    ],
    vehicles: [],
    zones: [
      {
        id: "zone-high",
        providerId: "provider-stable",
        providerGroupId: "group-stable",
        name: "No parking",
        z: 7,
        bbox: [0, 0, 10, 10],
        area,
        rules: [
          {
            vehicleTypeIds: ["type-bike"],
            rideStartAllowed: true,
            rideEndAllowed: false,
            rideThroughAllowed: true,
          },
        ],
        sourceId: "gbfs/example",
        servingOrigin: "motis-local",
      },
    ],
    completeness: {
      providers: true,
      providerGroups: true,
      stations: true,
      vehicles: true,
      zones: true,
      warnings: [],
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchMotisRentals.mockResolvedValue(snapshot());
  buildEnturGeofencingMapContext.mockResolvedValue(null);
});

describe("buildSharedMobilityMapContext", () => {
  it("uses complete MOTIS zones and station areas without an Entur call", async () => {
    const context = await buildSharedMobilityMapContext(bbox, new Set(["bicycle"]), runtime, {
      providerIds: ["provider-stable"],
      vehicleTypeIds: ["type-bike"],
      systemIds: ["provider-native"],
    });
    expect(buildEnturGeofencingMapContext).not.toHaveBeenCalled();
    expect(context?.geojson.features.map((feature) => feature.properties?.contextKind)).toEqual([
      "station_area",
      "restriction_zone",
    ]);
    expect(context?.geojson.features[1]?.properties).toMatchObject({
      zoneClass: "no_parking",
      z: 7,
      rideEndAllowed: false,
      providerName: "Example Mobility",
    });
  });

  it("filters provider-local rules by selected type", async () => {
    const context = await buildSharedMobilityMapContext(bbox, new Set(["bicycle"]), runtime, {
      providerIds: ["provider-stable"],
      vehicleTypeIds: ["other-type"],
      systemIds: ["provider-native"],
    });
    expect(context).toBeNull();
  });

  it("uses Entur only for systems absent from the MOTIS snapshot", async () => {
    buildEnturGeofencingMapContext.mockResolvedValue({
      geojson: {
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            geometry: area,
            properties: {
              contextKind: "restriction_zone",
              contextId: "entur:slow",
              systemId: "entur-only",
              zoneClass: "slow_zone",
              maximumSpeedKph: 10,
            },
          },
        ],
      },
    });
    const context = await buildSharedMobilityMapContext(bbox, new Set(["bicycle"]), runtime, {
      systemIds: ["provider-native", "entur-only"],
    });
    expect(buildEnturGeofencingMapContext).toHaveBeenCalledWith(bbox, {
      systemIds: ["entur-only"],
      vehicleTypeIds: undefined,
    });
    expect(
      context?.geojson.features.some((feature) => feature.properties?.maximumSpeedKph === 10),
    ).toBe(true);
  });

  it("enriches a selected system when MOTIS has station areas but no restriction zones", async () => {
    const partial = snapshot();
    partial.zones = [];
    fetchMotisRentals.mockResolvedValue(partial);
    buildEnturGeofencingMapContext.mockResolvedValue({
      geojson: {
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            geometry: area,
            properties: {
              contextKind: "restriction_zone",
              contextId: "entur:slow",
              systemId: "provider-native",
              zoneClass: "slow_zone",
              maximumSpeedKph: 12,
            },
          },
        ],
      },
    });

    const context = await buildSharedMobilityMapContext(bbox, new Set(["bicycle"]), runtime, {
      systemIds: ["provider-native"],
    });

    expect(buildEnturGeofencingMapContext).toHaveBeenCalledWith(bbox, {
      systemIds: ["provider-native"],
      vehicleTypeIds: undefined,
    });
    expect(context?.geojson.features.map((feature) => feature.properties?.contextKind)).toEqual([
      "station_area",
      "restriction_zone",
    ]);
  });
});
