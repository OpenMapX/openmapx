import type { IntegrationContext, TransitProvider } from "@openmapx/integration-framework";
import { licensingFromDeclaration } from "@openmapx/mobility-core/licensing";
import type { MotisInstance } from "@openmapx/mobility-core/motis-client";
import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ oneToAll: vi.fn(), stops: vi.fn() }));
vi.mock("@motis-project/motis-client", async (original) => ({
  ...(await original<typeof import("@motis-project/motis-client")>()),
  oneToAll: mocks.oneToAll,
  stops: mocks.stops,
}));
vi.mock("../rentals-capability.js", () => ({
  primeRentalFormFactors: vi.fn(),
  getRentalFormFactors: () => [],
}));

import { attribution } from "../attributions";
import { setupCloud } from "../cloud";
import { setupLocal } from "../local";

const hosted = { client: {}, prefix: "mo:", provider: "mo" } as MotisInstance;
const request = {
  origin: { lat: 59.9, lng: 10.7 },
  queryTime: "2026-10-13T10:00:00Z",
  direction: "depart-at" as const,
  thresholdsMinutes: [10],
  walkProfileId: "standard",
};
const supplier = {
  sourceId: "transitous",
  name: "Original Transitous",
  url: "https://transitous.org",
  licensing: licensingFromDeclaration("Mixed feeds", undefined),
  attribution: "Original data notice",
};

beforeEach(() => {
  mocks.stops.mockReset().mockRejectedValue(new Error("Local source unavailable"));
  mocks.oneToAll.mockReset().mockResolvedValue({
    data: {
      all: [
        {
          place: {
            stopId: "feed_oslo_stop",
            name: "Oslo",
            lat: 59.9,
            lon: 10.7,
            modes: ["RAIL"],
          },
          duration: 4,
        },
      ],
    },
  });
  attribution.set([supplier]);
});

for (const path of ["primary", "local fallback"] as const) {
  it(`keeps hosted ${path} location receipt while marking duration lineage unknown`, async () => {
    let provider: TransitProvider | undefined;
    const ctx = {
      config: {},
      log: { warn: vi.fn(), info: vi.fn() },
      registerTransitProvider: (p: TransitProvider) => {
        provider = p;
      },
    } as unknown as IntegrationContext;
    if (path === "primary") setupCloud(ctx, hosted, "primary");
    else
      setupLocal(ctx, {
        motisLocalInstance: { client: {}, prefix: "ms:", provider: "ms" } as MotisInstance,
        transitousInstance: hosted,
      });
    const result = await provider?.getReachabilitySurface?.(request);
    const seed = result?.data.seeds[0];
    expect(seed?.arrivalSeconds).toBe(240);
    expect(seed?.contributors?.map((r) => r.sourceId)).toEqual(["transitous"]);
    expect(seed?.stop.contributors?.map((r) => r.sourceId)).toEqual(["transitous"]);
    expect(seed?.fieldContributors?.lat?.map((r) => r.sourceId)).toEqual(["transitous"]);
    expect(seed?.fieldContributors?.arrivalSeconds).toEqual([]);
    expect(seed?.lineageComplete).toBe(false);
    expect(result?.data.lineageComplete).toBe(false);
    const retained = seed?.contributors;
    attribution.set([{ ...supplier, name: "Later catalogue" }]);
    expect(retained?.[0]).toMatchObject({
      name: supplier.name,
      attributionText: supplier.attribution,
    });
  });
}
