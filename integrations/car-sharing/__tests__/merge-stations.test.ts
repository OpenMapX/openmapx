import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@openmapx/core", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, mergeAttributions: vi.fn((a: unknown, b: unknown) => [a, b].flat()) };
});

import type { SharedMobilityStation } from "@openmapx/core";
import { mergeRegionalStations } from "../providers/merge-stations.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function makeAttribution(label: string) {
  return { label, url: `https://${label}.example.com` };
}

function makeStation(
  overrides: Partial<SharedMobilityStation> &
    Pick<SharedMobilityStation, "id" | "name" | "coordinates" | "source">,
): SharedMobilityStation {
  return {
    availableVehicles: 3,
    vehicleTypes: ["car"],
    isActive: true,
    attribution: makeAttribution(overrides.source),
    ...overrides,
  };
}

describe("mergeRegionalStations", () => {
  it("returns empty array for empty input", () => {
    expect(mergeRegionalStations([])).toEqual([]);
  });

  it("returns single station as a clone (not same reference)", () => {
    const station = makeStation({
      id: "c1",
      name: "Cambio Station",
      coordinates: [13.377, 52.52],
      source: "cambio",
    });
    const result = mergeRegionalStations([station]);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("c1");
    expect(result[0].name).toBe("Cambio Station");
    expect(result[0]).not.toBe(station); // cloned
    expect(result[0]).toEqual(station);
  });

  it("merges two stations within 50m: first keeps identity and availability", () => {
    // distanceM uses equirectangular approximation; we need real coordinates close enough
    // At ~52N: 1 degree lat ~ 111km, 1 degree lng ~ 67km
    // 0.0001 lat ~ 11m, so 0.0003 lat ~ 33m
    const primary = makeStation({
      id: "cambio-1",
      name: "Cambio Alexanderplatz",
      coordinates: [13.41, 52.52],
      source: "cambio",
      availableVehicles: 5,
      isActive: true,
      operator: "Cambio",
      attribution: makeAttribution("Cambio"),
    });
    const secondary = makeStation({
      id: "open-1",
      name: "Open Data Alex",
      coordinates: [13.41, 52.52003],
      source: "open-data",
      availableVehicles: 0,
      isActive: false,
      operator: "OpenData Provider",
      address: { street: "Alexanderstr. 1", city: "Berlin", postcode: "10178" },
      website: "https://carsharing.example.com",
      locationHint: "Next to the fountain",
      operatorNotes: "Return with full tank",
      transitInfo: { lines: "U5, U8", stops: "Alexanderplatz" },
      accessMethod: "App",
      vehicleClassNames: ["Mini", "Kombi"],
      stationType: "fixed" as const,
      capacity: 10,
      attribution: makeAttribution("OpenData"),
    });

    const result = mergeRegionalStations([primary, secondary]);
    expect(result).toHaveLength(1);

    const merged = result[0];
    // Identity and availability from primary (NOT overridden)
    expect(merged.id).toBe("cambio-1");
    expect(merged.name).toBe("Cambio Alexanderplatz");
    expect(merged.coordinates).toEqual([13.41, 52.52]);
    expect(merged.source).toBe("cambio");
    expect(merged.availableVehicles).toBe(5);
    expect(merged.isActive).toBe(true);
    expect(merged.operator).toBe("Cambio");

    // Enrichment fields from secondary
    expect(merged.address).toEqual({
      street: "Alexanderstr. 1",
      city: "Berlin",
      postcode: "10178",
    });
    expect(merged.website).toBe("https://carsharing.example.com");
    expect(merged.locationHint).toBe("Next to the fountain");
    expect(merged.operatorNotes).toBe("Return with full tank");
    expect(merged.transitInfo).toEqual({ lines: "U5, U8", stops: "Alexanderplatz" });
    expect(merged.accessMethod).toBe("App");
    expect(merged.vehicleClassNames).toEqual(["Mini", "Kombi"]);
    expect(merged.stationType).toBe("fixed");
    expect(merged.capacity).toBe(10);

    // Attribution merged from both
    expect(merged.attribution).toEqual([makeAttribution("Cambio"), makeAttribution("OpenData")]);
  });

  it("does NOT override primary fields with secondary values", () => {
    const primary = makeStation({
      id: "p1",
      name: "Primary Station",
      coordinates: [13.41, 52.52],
      source: "cambio",
      availableVehicles: 5,
      isActive: true,
      operator: "Cambio",
      address: { street: "Primary Street" },
      website: "https://primary.example.com",
      locationHint: "Primary hint",
      operatorNotes: "Primary notes",
      accessMethod: "Chipkarte",
      vehicleClassNames: ["Sedan"],
      stationType: "fixed" as const,
      capacity: 8,
    });
    const secondary = makeStation({
      id: "s1",
      name: "Secondary Station",
      coordinates: [13.41, 52.52003],
      source: "open-data",
      availableVehicles: 0,
      isActive: false,
      operator: "Other",
      address: { street: "Secondary Street" },
      website: "https://secondary.example.com",
      locationHint: "Secondary hint",
      operatorNotes: "Secondary notes",
      accessMethod: "App",
      vehicleClassNames: ["SUV"],
      stationType: "free" as const,
      capacity: 20,
    });

    const result = mergeRegionalStations([primary, secondary]);
    const merged = result[0];

    // Primary keeps all its own fields
    expect(merged.id).toBe("p1");
    expect(merged.name).toBe("Primary Station");
    expect(merged.source).toBe("cambio");
    expect(merged.availableVehicles).toBe(5);
    expect(merged.isActive).toBe(true);
    expect(merged.operator).toBe("Cambio");
    expect(merged.address).toEqual({ street: "Primary Street" });
    expect(merged.website).toBe("https://primary.example.com");
    expect(merged.locationHint).toBe("Primary hint");
    expect(merged.operatorNotes).toBe("Primary notes");
    expect(merged.accessMethod).toBe("Chipkarte");
    expect(merged.vehicleClassNames).toEqual(["Sedan"]);
    expect(merged.stationType).toBe("fixed");
    expect(merged.capacity).toBe(8);
  });

  it("keeps both when > 50m apart", () => {
    // 0.01 degrees lat at 52N ~ 1.11km — well over 50m
    const a = makeStation({
      id: "a",
      name: "Station A",
      coordinates: [13.41, 52.52],
      source: "cambio",
    });
    const b = makeStation({
      id: "b",
      name: "Station B",
      coordinates: [13.41, 52.53],
      source: "open-data",
    });

    const result = mergeRegionalStations([a, b]);
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe("a");
    expect(result[1].id).toBe("b");
  });

  it("three sources at same location: first is primary, second+third enrich", () => {
    const live = makeStation({
      id: "live-1",
      name: "Live Station",
      coordinates: [13.41, 52.52],
      source: "cambio-live",
      availableVehicles: 4,
      attribution: makeAttribution("Cambio"),
    });
    const openA = makeStation({
      id: "open-a",
      name: "Open A",
      coordinates: [13.41, 52.52001],
      source: "open-data-a",
      address: { street: "Hauptstr. 5", city: "Berlin" },
      transitInfo: { lines: "M10" },
      attribution: makeAttribution("OpenA"),
    });
    const openB = makeStation({
      id: "open-b",
      name: "Open B",
      coordinates: [13.41, 52.52002],
      source: "open-data-b",
      website: "https://booking.example.com",
      operatorNotes: "Park in marked spaces only",
      vehicleClassNames: ["Compact", "Estate"],
      attribution: makeAttribution("OpenB"),
    });

    const result = mergeRegionalStations([live, openA, openB]);
    expect(result).toHaveLength(1);

    const merged = result[0];
    // Identity from first (live)
    expect(merged.id).toBe("live-1");
    expect(merged.name).toBe("Live Station");
    expect(merged.source).toBe("cambio-live");
    expect(merged.availableVehicles).toBe(4);

    // Enrichment from second source (openA)
    expect(merged.address).toEqual({ street: "Hauptstr. 5", city: "Berlin" });
    expect(merged.transitInfo).toEqual({ lines: "M10" });

    // Enrichment from third source (openB) — only fields not yet filled by openA
    expect(merged.website).toBe("https://booking.example.com");
    expect(merged.operatorNotes).toBe("Park in marked spaces only");
    expect(merged.vehicleClassNames).toEqual(["Compact", "Estate"]);
  });

  it("does not mutate the input array or input station objects", () => {
    const station = makeStation({
      id: "s1",
      name: "Station",
      coordinates: [13.41, 52.52],
      source: "test",
    });
    const original = { ...station };
    const input = [station];

    mergeRegionalStations(input);

    expect(input).toHaveLength(1);
    expect(station.id).toBe(original.id);
    expect(station.name).toBe(original.name);
  });

  it("enriches capacity from secondary when primary has undefined capacity", () => {
    const primary = makeStation({
      id: "p1",
      name: "Primary",
      coordinates: [13.41, 52.52],
      source: "cambio",
      // capacity is undefined by default
    });
    const secondary = makeStation({
      id: "s1",
      name: "Secondary",
      coordinates: [13.41, 52.52001],
      source: "open-data",
      capacity: 15,
    });

    const result = mergeRegionalStations([primary, secondary]);
    expect(result[0].capacity).toBe(15);
  });

  it("does not override primary capacity with secondary capacity", () => {
    const primary = makeStation({
      id: "p1",
      name: "Primary",
      coordinates: [13.41, 52.52],
      source: "cambio",
      capacity: 8,
    });
    const secondary = makeStation({
      id: "s1",
      name: "Secondary",
      coordinates: [13.41, 52.52001],
      source: "open-data",
      capacity: 20,
    });

    const result = mergeRegionalStations([primary, secondary]);
    expect(result[0].capacity).toBe(8);
  });
});
