import {
  createPassthroughCache,
  fakeHttpClient,
  httpStatus,
} from "@openmapx/integration-framework/testing";
import { expect, it, vi } from "vitest";
import { createRegionalCarSharingRegistry } from "../providers/registry.js";
import { createStaticCarSharingClient } from "../providers/static-car-sharing-client.js";

it("captures each explicit regional client owner before its parsed cache and merge", async () => {
  const receipt = {
    sourceId: "de-cambio",
    name: "Cambio",
    attributionText: "Required Cambio notice",
  };
  const http = fakeHttpClient({ "https://example.com": { status: 200, headers: {}, body: "raw" } });
  const client = createStaticCarSharingClient({
    id: "de-cambio",
    name: "Cambio",
    url: "https://example.com",
    contentTypes: ["text/plain"],
    regions: [{ center: [13.4, 52.5], radiusKm: 20 }],
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
    http,
    log: { warn: vi.fn(), error: vi.fn() } as never,
    resolveContributors: (ids) => (ids.includes("de-cambio") ? [receipt] : []),
  });
  const result = await search({ west: 13.3, south: 52.4, east: 13.5, north: 52.6 });
  expect(result[0]?.contributors).toEqual([receipt]);
  expect(write.mock.calls[0]?.[1]).toEqual([expect.objectContaining({ contributors: [receipt] })]);
  expect(http.calls[0]).toMatchObject({ method: "getText", url: "https://example.com" });
  expect(http.calls[0]?.options).toMatchObject({
    contentTypes: ["text/plain"],
    maxBytes: 2 * 1024 * 1024,
  });
});

it("returns no stations without caching when a static feed fails", async () => {
  const client = createStaticCarSharingClient({
    id: "de-nw-wuppertal",
    name: "Wuppertal",
    url: "https://feed.example/stations.json",
    contentTypes: ["application/json"],
    regions: [{ center: [7.18, 51.26], radiusKm: 15 }],
    parse: () => {
      throw new Error("must not parse a failed answer");
    },
  });
  const cache = createPassthroughCache();
  const write = vi.spyOn(cache, "set");

  const stations = await client.search(
    { west: 7.1, south: 51.2, east: 7.3, north: 51.3 },
    { cache, http: fakeHttpClient(() => httpStatus(503)) },
  );

  expect(stations).toEqual([]);
  expect(write).not.toHaveBeenCalled();
});
