import type { IntegrationContext } from "@openmapx/integration-framework";
import { createMockIntegrationContext } from "@openmapx/integration-framework/testing";
import { describe, expect, it, vi } from "vitest";
import { enrichJourneyPlatforms } from "../journey-platforms";

const base = {
  data: {
    id: "mo:trip",
    name: "RE1",
    provider: "mo",
    stops: [{ stopId: "a", name: "A", lat: 50, lng: 6, platform: "78", scheduledPlatform: "78" }],
  },
  attributions: [{ sourceId: "baseline", name: "Baseline" }],
  freshness: { fetchedAt: "2026-11-06T21:19:00Z", hasRealtimeData: true, isStale: false },
};
function context(disabled = false) {
  const ctx = createMockIntegrationContext();
  const acquire = vi.fn(async () => ({
    data: [
      {
        stopIndex: 0,
        departurePlatform: { code: "3", scheduledCode: "3", kind: "correction", sourceId: "siri" },
      },
    ],
    attributions: [{ sourceId: "siri", name: "SIRI" }],
    freshness: { ...base.freshness, hasRealtimeData: false },
  }));
  Object.assign(ctx, {
    getDisallowedSourceIds: async () => new Set(disabled ? ["siri"] : []),
    getIntegrationsByDomain: () => [
      {
        manifest: { dataSources: [{ sourceId: "siri" }] },
        providers: new Map([
          [
            "live-transit",
            [
              {
                id: "siri",
                priority: 1,
                coverage: { all: true },
                capabilities: { journeyPlatforms: true },
                getJourneyPlatforms: acquire,
              },
            ],
          ],
        ]),
      },
    ],
  });
  return { ctx, acquire };
}
const timed = async <T>(_id: string, _method: string, fn: () => Promise<T>) => ({
  ok: true as const,
  value: await fn(),
});
describe("journey passenger-platform enrichment", () => {
  it("corrects a cloned journey, retaining identity, baseline and supplier receipts", async () => {
    const f = context();
    const result = await enrichJourneyPlatforms({ ctx: f.ctx as IntegrationContext, timed }, base);
    expect(result.data?.stops[0]).toMatchObject({ platform: "3", scheduledPlatform: "3" });
    expect(base.data.stops[0].platform).toBe("78");
    expect(result.attributions.map((a) => a.sourceId)).toEqual(["baseline", "siri"]);
    expect(result.data?.id).toBe("mo:trip");
  });
  it("never queries or publishes a source disabled by policy", async () => {
    const f = context(true);
    expect(await enrichJourneyPlatforms({ ctx: f.ctx, timed }, base)).toBe(base);
    expect(f.acquire).not.toHaveBeenCalled();
  });
  it("checks policy again after asynchronous acquisition", async () => {
    const f = context();
    const acquire = f.acquire.getMockImplementation();
    if (!acquire) throw new Error("Missing platform acquisition fixture");
    f.acquire.mockImplementation(async () => {
      Object.assign(f.ctx, { getDisallowedSourceIds: async () => new Set(["siri"]) });
      return acquire();
    });
    expect(await enrichJourneyPlatforms({ ctx: f.ctx, timed }, base)).toBe(base);
  });
});

it("keeps the baseline usable when platform acquisition fails", async () => {
  const f = context();
  f.acquire.mockRejectedValue(new Error("upstream"));
  expect(await enrichJourneyPlatforms({ ctx: f.ctx, timed }, base)).toBe(base);
});
