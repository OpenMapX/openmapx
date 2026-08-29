import type { IntegrationContext, TransitProvider } from "@openmapx/integration-framework";
import { createMockIntegrationContext } from "@openmapx/integration-framework/testing";
import { freshnessNow } from "@openmapx/mobility-core/freshness";
import { withAttribution } from "@openmapx/mobility-core/result";
import type { TransitReachabilitySurface } from "@openmapx/mobility-core/transit-reachability";
import { describe, expect, it, vi } from "vitest";
import { setup } from "../index.js";
import {
  MAX_TRANSIT_REACHABILITY_SEEDS,
  thinTransitReachabilitySurface,
  transitCheckCacheKey,
  transitSurfaceCacheKey,
} from "../reachability.js";

const request = {
  origin: { lng: 13.4, lat: 52.5 },
  queryTime: "2026-08-29T08:31:00.000Z",
  direction: "depart-at" as const,
  thresholdsMinutes: [15, 30],
  walkProfileId: "foot-1.2-cap-900-v1" as const,
};

describe("transit reachability server helpers", () => {
  it("keeps the earliest seed in a grid cell", () => {
    const surface = {
      queryTime: request.queryTime,
      source: "self-hosted-motis",
      capabilities: {
        estimatedSurface: true,
        exactPointChecks: false,
        exactPointCheckReason: "operator-disabled",
        maxDestinationsPerBatch: 128,
        maxTravelTimeMinutes: 90,
        datasetEpoch: "e1",
      },
      seeds: [
        { lng: 13.4, lat: 52.5, arrivalSeconds: 600 },
        { lng: 13.40001, lat: 52.50001, arrivalSeconds: 300 },
      ],
      thinning: { originalSeedCount: 0, seedCount: 0, gridMetres: 0 },
    } satisfies TransitReachabilitySurface;
    expect(thinTransitReachabilitySurface(surface).seeds).toEqual([
      expect.objectContaining({ arrivalSeconds: 300 }),
    ]);
  });

  it("coarsens deterministically to the seed ceiling", () => {
    const surface = {
      queryTime: request.queryTime,
      source: "transitous",
      capabilities: {
        estimatedSurface: true,
        exactPointChecks: false,
        exactPointCheckReason: "hosted-source",
        maxDestinationsPerBatch: null,
        maxTravelTimeMinutes: 90,
        datasetEpoch: null,
      },
      seeds: Array.from({ length: 5_000 }, (_, index) => ({
        lng: 5 + index * 0.002,
        lat: 50,
        arrivalSeconds: index,
      })),
      thinning: { originalSeedCount: 0, seedCount: 0, gridMetres: 0 },
    } satisfies TransitReachabilitySurface;
    const thinned = thinTransitReachabilitySurface(surface);
    expect(thinned.seeds.length).toBeLessThanOrEqual(MAX_TRANSIT_REACHABILITY_SEEDS);
    expect(thinned.thinning.originalSeedCount).toBe(5_000);
    expect(thinned.thinning.gridMetres).toBeGreaterThanOrEqual(100);
  });

  it("uses time, epoch, and ordered destinations in cache identities", () => {
    expect(transitSurfaceCacheKey(request, "e1")).not.toBe(
      transitSurfaceCacheKey({ ...request, queryTime: "2026-08-29T08:32:00.000Z" }, "e1"),
    );
    expect(transitSurfaceCacheKey(request, "e1")).not.toBe(transitSurfaceCacheKey(request, "e2"));
    const a = { id: "a", lng: 13.4, lat: 52.5 };
    const b = { id: "b", lng: 13.5, lat: 52.6 };
    expect(transitCheckCacheKey({ ...request, destinations: [a, b] }, "e1")).not.toBe(
      transitCheckCacheKey({ ...request, destinations: [b, a] }, "e1"),
    );
  });

  function provider(exactPointChecks: boolean): TransitProvider {
    const capabilities = {
      estimatedSurface: true,
      exactPointChecks,
      exactPointCheckReason: exactPointChecks
        ? ("available" as const)
        : ("operator-disabled" as const),
      maxDestinationsPerBatch: exactPointChecks ? 128 : null,
      maxTravelTimeMinutes: 90,
      datasetEpoch: "epoch-1",
    };
    return {
      id: "reach",
      prefix: "r:",
      coverage: { all: true },
      priority: 1,
      role: "baseline",
      attribution: [{ sourceId: "tiny", name: "Tiny GTFS" }],
      capabilities: {
        stops: {
          lookup: false,
          nearby: false,
          bbox: false,
          search: false,
          infrastructure: false,
          platforms: false,
          timetable: false,
        },
        departures: false,
        arrivals: false,
        routes: { lookup: false, forStop: false, stops: false, geometry: false },
        planning: false,
        vehiclePositions: false,
        vehicleJourney: false,
        alerts: { byStop: false, byRoute: false, byBbox: false },
        facilities: false,
        reachability: { estimatedSurface: true, exactPointChecks: true },
      },
      getReachabilityCapabilities: async () => capabilities,
      getReachabilitySurface: async (surfaceRequest) =>
        withAttribution(
          {
            queryTime: surfaceRequest.queryTime,
            source: "self-hosted-motis",
            capabilities,
            seeds: [{ lng: 13.41, lat: 52.51, arrivalSeconds: 600 }],
            thinning: { originalSeedCount: 1, seedCount: 1, gridMetres: 0 },
          },
          [{ sourceId: "tiny", name: "Tiny GTFS" }],
          freshnessNow(),
        ),
      checkReachabilityDestinations: async (checkRequest) =>
        withAttribution(
          {
            queryTime: checkRequest.queryTime,
            results: checkRequest.destinations.map(({ id }) => ({
              id,
              durationSeconds: 600,
              reachable: true,
            })),
          },
          [{ sourceId: "tiny", name: "Tiny GTFS" }],
          freshnessNow(),
        ),
    };
  }

  function registeredRoutes(exactPointChecks: boolean) {
    const ctx = createMockIntegrationContext({ id: "transit" });
    const transitProvider = provider(exactPointChecks);
    (
      ctx as unknown as { getIntegrationsByDomain: IntegrationContext["getIntegrationsByDomain"] }
    ).getIntegrationsByDomain = (domain) =>
      domain === "transit"
        ? ([{ providers: new Map([["transit", [transitProvider]]]) }] as never)
        : [];
    setup(ctx);
    return ctx.registered.routes;
  }

  function replyCapture() {
    const capture = {
      status: 200,
      body: undefined as unknown,
      headers: {} as Record<string, string>,
    };
    const reply = {
      send: (body: unknown) => {
        capture.body = body;
      },
      status: (status: number) => {
        capture.status = status;
        return { send: (body: unknown) => (capture.body = body) };
      },
      header: (name: string, value: string) => {
        capture.headers[name] = value;
      },
      type: vi.fn(),
    };
    return { capture, reply };
  }

  function reachabilityRoute(exact: boolean, path: string) {
    const route = registeredRoutes(exact).find((item) => item.path === path);
    if (!route) throw new Error(`missing registered route ${path}`);
    return route;
  }

  it("returns a source-attributed, thinned surface envelope", async () => {
    const route = reachabilityRoute(true, "/reachability/surface");
    const { capture, reply } = replyCapture();
    await route.handler(
      { query: {}, params: {}, body: request, headers: {}, signal: new AbortController().signal },
      reply,
    );
    expect(capture.status).toBe(200);
    expect(capture.headers["Cache-Control"]).toBe("public, max-age=300");
    expect(capture.body).toMatchObject({
      data: {
        source: "self-hosted-motis",
        thinning: { originalSeedCount: 1, seedCount: 1, gridMetres: 100 },
      },
      attributions: [{ sourceId: "tiny" }],
    });
  });

  it("rejects exact requests with 409 when the effective capability is off", async () => {
    const route = reachabilityRoute(false, "/reachability/check");
    const { capture, reply } = replyCapture();
    await route.handler(
      {
        query: {},
        params: {},
        body: { ...request, destinations: [{ id: "a", lng: 13.4, lat: 52.5 }] },
        headers: {},
        signal: new AbortController().signal,
      },
      reply,
    );
    expect(capture.status).toBe(409);
    expect(capture.body).toMatchObject({ reason: "operator-disabled" });
  });
});
