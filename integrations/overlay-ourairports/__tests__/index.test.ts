import { createMockIntegrationContext } from "@openmapx/integration-framework/testing";
import { describe, expect, it, vi } from "vitest";
import { setup } from "../index";
import manifest from "../manifest.json";

vi.mock("@openmapx/ourairports-data", () => ({
  startBackgroundLoad: () => () => {},
  queryAirportsInBbox: vi.fn(async () => [
    {
      id: 1,
      ident: "A",
      name: "Airport A",
      type: "large_airport",
      lng: 0,
      lat: 0,
      scheduledService: true,
    },
  ]),
}));
describe("airport acquisition before bbox caching", () => {
  it("caches immutable feature receipt including original required notice", async () => {
    const declared = {
      ...structuredClone(manifest),
      dataSources: manifest.dataSources.map((source) => ({
        ...source,
        attribution: "Original airport required notice",
      })),
    };
    const cached = new Map<string, unknown>();
    const ctx = createMockIntegrationContext({ manifest: declared as never });
    ctx.cache.withCache = async <T>(key: string, _ttl: number, load: () => Promise<T>) => {
      if (cached.has(key)) return cached.get(key) as T;
      const data = await load();
      cached.set(key, data);
      return data;
    };
    setup(ctx);
    const handler = ctx.registered.routes.find((route) => route.path === "/airports")?.handler;
    if (!handler) throw new Error("Missing airport route");
    const bodies: unknown[] = [];
    const reply = {
      header() {
        return this;
      },
      send(body: unknown) {
        bodies.push(body);
        return this;
      },
    };
    const req = {
      query: { west: "-1", south: "-1", east: "1", north: "1" },
      params: {},
      headers: {},
      body: undefined,
    };
    await handler(req, reply as never);
    const source = declared.dataSources[0];
    if (!source) throw new Error("Missing fixture source");
    source.attribution = "New registry notice";
    await handler(req, reply as never);
    const result = bodies[1] as GeoJSON.FeatureCollection;
    expect(JSON.parse(result.features[0]?.properties?._mapAttributions)[0].attributionText).toBe(
      "Original airport required notice",
    );
    expect(bodies[0]).toBe(bodies[1]);
  });
});
