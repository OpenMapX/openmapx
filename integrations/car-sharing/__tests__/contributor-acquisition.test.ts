import { createPassthroughCache } from "@openmapx/integration-framework/testing";
import { afterEach, expect, it, vi } from "vitest";
import { createRegionalCarSharingRegistry } from "../providers/registry.js";
import { createStaticCarSharingClient } from "../providers/static-car-sharing-client.js";

afterEach(() => vi.unstubAllGlobals());
it("captures each explicit regional client owner before its parsed cache and merge", async () => {
  const receipt = {
    sourceId: "de-cambio",
    name: "Cambio",
    attributionText: "Required Cambio notice",
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("raw", { status: 200 })),
  );
  const client = createStaticCarSharingClient({
    id: "de-cambio",
    name: "Cambio",
    url: "https://example.com",
    regions: [{ center: [13.4, 52.5], radiusKm: 20 }],
    attribution: { label: "Cambio", url: "https://example.com" },
    parse: () => [
      {
        id: "de-cambio/region/station",
        name: "Station",
        coordinates: [13.4, 52.5],
        availableVehicles: 1,
        vehicleTypes: ["car"],
        isActive: true,
        sources: ["de-cambio/region"],
      },
    ],
  });
  const cache = createPassthroughCache();
  const write = vi.spyOn(cache, "set");
  const search = createRegionalCarSharingRegistry({
    clients: [client],
    cache,
    log: { warn: vi.fn(), error: vi.fn() } as never,
    resolveContributors: (ids) => (ids.includes("de-cambio") ? [receipt] : []),
  });
  const result = await search({ west: 13.3, south: 52.4, east: 13.5, north: 52.6 });
  expect(result[0].contributors).toEqual([receipt]);
  expect(write.mock.calls[0]?.[1]).toEqual([expect.objectContaining({ contributors: [receipt] })]);
});
