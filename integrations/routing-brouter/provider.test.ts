import type { IntegrationContext } from "@openmapx/integration-framework";
import { describe, expect, it, vi } from "vitest";
import fixture from "./__fixtures__/aachen.json";
import { setup } from "./index";
import { createBrouterProvider } from "./provider";

const points: [number, number][] = [
  [6.08, 50.775],
  [6.09, 50.777],
  [6.1, 50.78],
];
function context() {
  return {
    config: {},
    getRequiredService: vi.fn(() => null),
    registerRoutingProvider: vi.fn(),
    http: { get: vi.fn().mockResolvedValue(fixture) },
  } as unknown as IntegrationContext;
}
describe("optional BRouter provider", () => {
  it("registers only when an operator endpoint or service is configured", () => {
    const ctx = context();
    setup(ctx);
    expect(ctx.registerRoutingProvider).not.toHaveBeenCalled();
    Object.assign(ctx.config, { endpoint: "http://brouter:17777" });
    setup(ctx);
    expect(ctx.registerRoutingProvider).toHaveBeenCalledOnce();
  });
  it("serves only cycling and leaves timed/optimized routing to capable engines", async () => {
    const p = createBrouterProvider(context(), "http://brouter:17777");
    expect(p.supportedModes).toEqual(["cycling"]);
    expect(p.priority).toBeLessThan(10);
    expect(p.supportsTimeAware).not.toBe(true);
    expect(p.optimizeRoute).toBeUndefined();
    await expect(p.getRoute(points, "walking")).rejects.toThrow();
    await expect(p.getRoute(points, "cycling", { departAt: "2026-10-17T09:00" })).rejects.toThrow();
  });
  it.each([
    ["trekking", "trekking"],
    ["road", "fastbike"],
    ["gravel", "gravel"],
    ["mountain", "mtb"],
  ] as const)("maps %s to %s", async (bikeProfile, profile) => {
    const ctx = context();
    await createBrouterProvider(ctx, "http://brouter:17777/").getRoute(points, "cycling", {
      bikeProfile,
      alternatives: false,
    });
    expect(ctx.http.get).toHaveBeenCalledWith(
      "http://brouter:17777/brouter",
      expect.objectContaining({
        params: expect.objectContaining({ profile, timode: 2 }),
        timeoutMs: 35000,
      }),
    );
  });
  it("honors quiet roads, hills, ferry avoidance and closure geometry", async () => {
    const ctx = context();
    await createBrouterProvider(ctx, "http://brouter:17777").getRoute(points, "cycling", {
      bikeProfile: "road",
      bikeHillPreference: "strongly-avoid",
      bikePreferQuietRoads: true,
      avoidFerries: true,
      excludeLocations: [[6.2, 50.8]],
      excludePolygons: [
        [
          [6, 50],
          [6.1, 50],
          [6, 50.1],
          [6, 50],
        ],
      ],
      alternatives: false,
    });
    expect(ctx.http.get).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        params: expect.objectContaining({
          profile: "fastbike-verylowtraffic",
          "profile:allow_ferries": 0,
          "profile:uphillcost": 160,
          nogos: "6.2,50.8,30,-1",
          polygons: "6,50,6.1,50,6,50.1,6,50,-1",
        }),
      }),
    );
  });
  it("fails unsupported ferry avoidance so the orchestrator can use Valhalla", async () => {
    await expect(
      createBrouterProvider(context(), "http://brouter:17777").getRoute(points, "cycling", {
        bikeProfile: "gravel",
        avoidFerries: true,
      }),
    ).rejects.toThrow(/ferr/);
  });
  it("keeps the main route when an alternative fails", async () => {
    const ctx = context();
    vi.mocked(ctx.http.get)
      .mockResolvedValueOnce(fixture)
      .mockRejectedValueOnce(new Error("timeout"));
    const result = await createBrouterProvider(ctx, "http://brouter:17777").getRoute(
      points,
      "cycling",
    );
    expect(result.routes).toHaveLength(1);
    expect(ctx.http.get).toHaveBeenCalledTimes(2);
  });
  it("propagates primary timeout and no-route errors", async () => {
    const ctx = context();
    vi.mocked(ctx.http.get).mockRejectedValueOnce(new Error("timeout"));
    const p = createBrouterProvider(ctx, "http://brouter:17777");
    await expect(p.getRoute(points, "cycling")).rejects.toThrow("timeout");
    vi.mocked(ctx.http.get).mockResolvedValue({ features: [] });
    await expect(p.getRoute(points, "cycling")).rejects.toThrow(/route/);
  });
});

it("falls through for unsupported strong gravel hill avoidance before any HTTP request", async () => {
  const ctx = context();
  await expect(
    createBrouterProvider(ctx, "http://brouter:17777").getRoute(points, "cycling", {
      bikeProfile: "gravel",
      bikeHillPreference: "strongly-avoid",
    }),
  ).rejects.toThrow(/hill/);
  expect(ctx.http.get).not.toHaveBeenCalled();
});

it.each([{ bikePreferSmoothSurfaces: true }, { bikeSpeedKmh: 19.5 }])(
  "defers unsupported explicit preferences %j before acquisition",
  async (options) => {
    const ctx = context();
    await expect(
      createBrouterProvider(ctx, "http://brouter:17777").getRoute(points, "cycling", options),
    ).rejects.toThrow(/preference/);
    expect(ctx.http.get).not.toHaveBeenCalled();
  },
);
