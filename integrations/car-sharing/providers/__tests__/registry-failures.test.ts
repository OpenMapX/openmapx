import type { BoundingBox } from "@openmapx/core";
import { createPassthroughCache } from "@openmapx/integration-framework/testing";
import type { SharedMobilityStation } from "@openmapx/mobility-core/shared-mobility";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RegionalCarSharingClient } from "../regional-client-types.js";
import { createRegionalCarSharingRegistry } from "../registry.js";

function makeStation(id: string): SharedMobilityStation {
  return {
    id,
    name: `Station ${id}`,
    coordinates: [13.4, 52.5],
    availableVehicles: 2,
    vehicleTypes: ["bicycle"],
    isActive: true,
    sources: ["test-client"],
  };
}

function makeFakeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

function makeClient(
  id: string,
  centerLng: number,
  centerLat: number,
  searchImpl: (bbox: BoundingBox) => Promise<SharedMobilityStation[]>,
): RegionalCarSharingClient {
  return {
    id,
    name: `Client ${id}`,
    regions: [{ center: [centerLng, centerLat], radiusKm: 50 }],
    attribution: { label: `Client ${id}`, url: `https://example.com/${id}` },
    search: searchImpl,
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("searchRegionalClients — one source rejects", () => {
  // Use Berlin bbox (around 13.4, 52.5)
  const bbox: BoundingBox = { south: 52.4, west: 13.3, north: 52.6, east: 13.5 };

  it("returns healthy stations and warns once for the failing client id", async () => {
    const fakeLogger = makeFakeLogger();

    const station = makeStation("berlin-station");
    const goodClient = makeClient("berlin-good", 13.4, 52.5, async () => [station]);
    const badClient = makeClient("berlin-bad", 13.4, 52.5, async () => {
      throw new Error("network error");
    });

    const searchRegionalClients = createRegionalCarSharingRegistry({
      clients: [goodClient, badClient],
      cache: createPassthroughCache(),
      log: fakeLogger,
    });
    const result = await searchRegionalClients(bbox);

    expect(result.some((s) => s.id === "berlin-station")).toBe(true);
    expect(fakeLogger.warn).toHaveBeenCalledOnce();
    expect(fakeLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining("berlin-bad"),
      expect.any(Error),
    );
    expect(fakeLogger.error).not.toHaveBeenCalled();
  });
});

describe("searchRegionalClients — all sources reject", () => {
  // Use Paris bbox (around 2.3, 48.8) — isolated from the Berlin clients above
  const bbox: BoundingBox = { south: 48.7, west: 2.2, north: 48.9, east: 2.4 };

  it("returns empty array and logs error when every client rejects", async () => {
    const fakeLogger = makeFakeLogger();

    const clientA = makeClient("paris-fail-a", 2.3, 48.8, async () => {
      throw new Error("fail A");
    });
    const clientB = makeClient("paris-fail-b", 2.3, 48.8, async () => {
      throw new Error("fail B");
    });

    const searchRegionalClients = createRegionalCarSharingRegistry({
      clients: [clientA, clientB],
      cache: createPassthroughCache(),
      log: fakeLogger,
    });
    const result = await searchRegionalClients(bbox);

    expect(result).toEqual([]);
    expect(fakeLogger.warn).toHaveBeenCalledTimes(2);
    expect(fakeLogger.error).toHaveBeenCalledOnce();
    expect(fakeLogger.error).toHaveBeenCalledWith("all car-sharing sources failed");
  });
});
