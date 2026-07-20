import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MotisCandidateManifest } from "../../src/jobs/transitous/candidate.js";
import { runFunctionalProbes } from "../../src/jobs/transitous/functional-probes.js";
import { probeHttp } from "../../src/jobs/transitous/motis-probe.js";

const originalFetch = globalThis.fetch;
const originalProbeGet = probeHttp.get;
// Route the probe HTTP layer back through the mocked global fetch (production
// uses node:http to dodge an undici parser bug on large MOTIS responses).
beforeEach(() => {
  probeHttp.get = (url) => fetch(url);
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  probeHttp.get = originalProbeGet;
});

function manifest(expectsGbfs = true): MotisCandidateManifest {
  const artifact = { path: "x", sha256: "a".repeat(64), sizeBytes: 1 };
  return {
    schemaVersion: 1,
    epoch: "epoch-1",
    createdAt: "2026-01-01T00:00:00Z",
    expectations: {
      timetableDatasets: 1,
      realtimeFeeds: 0,
      gbfsFeeds: expectsGbfs ? 1 : 0,
      expectsGbfs,
      tilesEnabled: false,
      elevationEnabled: false,
      routedTransfersEnabled: false,
      gbfsProxyUrl: expectsGbfs ? "http://motis-feed-proxy" : null,
      feedProxyUrls: [],
    },
    canary: {
      bbox: { minLat: 1, minLng: 2, maxLat: 3, maxLng: 4 },
      plan: { fromLat: 1, fromLng: 2, toLat: 3, toLng: 4 },
      expectedRentalProviderIds: expectsGbfs ? ["provider-1"] : [],
    },
    artifacts: {
      config: artifact,
      license: artifact,
      proxyConfig: artifact,
      proxyVars: artifact,
      datasets: [artifact],
    },
  };
}

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
}

function validBody(url: string): unknown {
  if (url.includes("/health")) return { rt: true, gbfs: true };
  if (url.includes("/map/initial")) return { lat: 1, lon: 2, zoom: 3, serverConfig: {} };
  if (url.includes("/map/stops")) return [];
  if (url.includes("/rentals")) {
    return {
      providerGroups: [
        { id: "group-1", name: "Group", providers: ["provider-1"], formFactors: ["BICYCLE"] },
      ],
      providers: [
        {
          id: "provider-1",
          name: "Provider",
          groupId: "group-1",
          bbox: [1, 2, 3, 4],
          formFactors: ["BICYCLE"],
          vehicleTypes: [
            {
              id: "bike",
              formFactor: "BICYCLE",
              propulsionType: "HUMAN",
              returnConstraint: "STATION",
              returnConstraintGuessed: false,
            },
          ],
          defaultRestrictions: {
            vehicleTypeIdxs: [],
            rideStartAllowed: true,
            rideEndAllowed: true,
            rideThroughAllowed: true,
          },
          globalGeofencingRules: [],
        },
      ],
      stations: [],
      vehicles: [],
      zones: [],
    };
  }
  return { itineraries: [{}], direct: [], requestParameters: {}, debugOutput: {} };
}

describe("typed MOTIS functional probes", () => {
  it("accepts station-only or temporarily empty inventory when provider enumeration is valid", async () => {
    globalThis.fetch = vi.fn(async (input: unknown) =>
      response(validBody(String(input))),
    ) as typeof fetch;
    const report = await runFunctionalProbes("http://motis", manifest(), Date.now() + 10_000);
    expect(report.ok).toBe(true);
    expect(report.rentals).toMatchObject({
      providerIds: ["provider-1"],
      providerGroupIds: ["group-1"],
      formFactors: ["BICYCLE"],
      returnConstraints: ["STATION"],
    });
  });

  it("fails closed when configured GBFS reports unhealthy", async () => {
    globalThis.fetch = vi.fn(async (input: unknown) => {
      const url = String(input);
      return response(url.includes("/health") ? { gbfs: false } : validBody(url));
    }) as typeof fetch;
    const report = await runFunctionalProbes("http://motis", manifest(), Date.now() + 10_000);
    expect(report.ok).toBe(false);
    expect(report.failure).toMatchObject({ name: "health" });
    expect(report.failure?.evidence).toContain("health.gbfs");
  });

  it("fails on empty provider enumeration instead of treating zero inventory as coverage", async () => {
    globalThis.fetch = vi.fn(async (input: unknown) => {
      const url = String(input);
      return response(
        url.includes("/rentals")
          ? { providerGroups: [], providers: [], stations: [], vehicles: [], zones: [] }
          : validBody(url),
      );
    }) as typeof fetch;
    const report = await runFunctionalProbes("http://motis", manifest(), Date.now() + 10_000, {
      sleep: async () => {},
      rentalsWarmupMs: 30,
      rentalsPollIntervalMs: 10,
    });
    expect(report.ok).toBe(false);
    expect(report.failure).toMatchObject({ name: "rentals" });
  });

  it("retries the rentals probe through GBFS warm-up until inventory appears", async () => {
    // MOTIS reports healthy before its first GBFS poll lands, so a freshly
    // (re)started instance enumerates zero rentals for a few seconds. The probe
    // must tolerate that warm-up window rather than fail the whole promote.
    let rentalCalls = 0;
    globalThis.fetch = vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes("/rentals")) {
        rentalCalls++;
        if (rentalCalls <= 2) {
          return response({
            providerGroups: [],
            providers: [],
            stations: [],
            vehicles: [],
            zones: [],
          });
        }
      }
      return response(validBody(url));
    }) as typeof fetch;
    const report = await runFunctionalProbes("http://motis", manifest(), Date.now() + 10_000, {
      sleep: async () => {},
      rentalsWarmupMs: 100,
      rentalsPollIntervalMs: 10,
    });
    expect(report.ok).toBe(true);
    expect(rentalCalls).toBeGreaterThanOrEqual(3);
    expect(report.rentals?.providerIds).toEqual(["provider-1"]);
  });

  it("does not call rentals when the exact candidate has no GBFS configuration", async () => {
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (input: unknown) => {
      calls.push(String(input));
      return response(validBody(String(input)));
    }) as typeof fetch;
    const report = await runFunctionalProbes("http://motis", manifest(false), Date.now() + 10_000);
    expect(report.ok).toBe(true);
    expect(calls.some((url) => url.includes("/rentals"))).toBe(false);
  });
});
