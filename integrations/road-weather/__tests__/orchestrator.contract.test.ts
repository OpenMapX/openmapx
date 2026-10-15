import type { BoundingBox } from "@openmapx/core";
import type {
  IntegrationContext,
  RoadWeatherProvider,
  RoadWeatherStation,
} from "@openmapx/integration-framework";
import { describe, expect, test, vi } from "vitest";
import { createRoadWeatherDataSource } from "../data-source.js";

/** A box a map at zoom 10 shows around Espoo. */
const BBOX: BoundingBox = { west: 24.4, south: 60.1, east: 24.9, north: 60.35 };

function station(
  over: Partial<RoadWeatherStation> & Pick<RoadWeatherStation, "id">,
): RoadWeatherStation {
  return {
    name: `Station ${over.id}`,
    coordinates: [24.6, 60.2],
    status: "operational",
    air: { temperatureC: { value: 1.2 } },
    surface: [{ index: 1, state: { value: "dry" } }],
    stale: false,
    sources: ["src-a"],
    attributions: [{ sourceId: "src-a", name: "Source A" }],
    ...over,
  };
}

function provider(
  id: string,
  stations: RoadWeatherStation[] | Error,
  over: Partial<RoadWeatherProvider> = {},
): RoadWeatherProvider {
  return {
    id,
    searchStations: vi.fn(async () => {
      if (stations instanceof Error) throw stations;
      return { stations };
    }),
    getStation: vi.fn(async (stationId: string) =>
      stations instanceof Error ? null : (stations.find((s) => s.id === stationId) ?? null),
    ),
    ...over,
  };
}

/** A context over `providers` under the `road-weather` domain. */
function ctxWith(
  providers: RoadWeatherProvider[],
  opts: { disallowed?: string[] } = {},
): IntegrationContext {
  const quiet = (): void => {};
  return {
    getIntegrationsByDomain: (domain: string) =>
      domain === "road-weather"
        ? providers.map((p) => ({
            id: p.id,
            providers: new Map<string, RoadWeatherProvider[]>([["road-weather", [p]]]),
          }))
        : [],
    getDisallowedSourceIds: opts.disallowed ? async () => new Set(opts.disallowed) : undefined,
    log: { warn: quiet, error: quiet, info: quiet, debug: quiet },
  } as unknown as IntegrationContext;
}

describe("road-weather data source", () => {
  test("merges providers, survives one failing, and passes a partial reason through", async () => {
    const a = provider("a", [station({ id: "a:1" }), station({ id: "a:2" })]);
    const source = createRoadWeatherDataSource(
      ctxWith([
        a,
        provider("b", new Error("upstream down")),
        provider("c", [], {
          searchStations: vi.fn(async () => ({
            stations: [station({ id: "c:1", sources: ["src-c"] })],
            partial: "area" as const,
          })),
        }),
      ]),
    );

    const result = await source.search(BBOX);

    expect(result.data.map((r) => r.id)).toEqual(["a:1", "a:2", "c:1"]);
    expect(result.partial).toBe("area");
    expect(a.searchStations).toHaveBeenCalledWith([24.4, 60.1, 24.9, 60.35], expect.any(Object));
    expect(source.id).toBe("road-weather");
    expect(source.attribution).toEqual([]);
  });

  test("keeps out a station of a source the operator disallows", async () => {
    const source = createRoadWeatherDataSource(
      ctxWith(
        [provider("a", [station({ id: "a:1" }), station({ id: "a:2", sources: ["src-x"] })])],
        {
          disallowed: ["src-x"],
        },
      ),
    );
    expect((await source.search(BBOX)).data.map((r) => r.id)).toEqual(["a:1"]);
  });

  test("filters by what lies on the road", async () => {
    const source = createRoadWeatherDataSource(
      ctxWith([
        provider("a", [
          station({ id: "dry" }),
          station({ id: "icy", surface: [{ index: 1, state: { value: "black_ice" } }] }),
          station({ id: "slush", surface: [{ index: 1, state: { value: "slush" } }] }),
        ]),
      ]),
    );
    const slippery = await source.search(BBOX, { surface: ["icy", "snowy"] });
    expect(slippery.data.map((r) => r.id)).toEqual(["icy", "slush"]);
    expect((await source.getFilters())[0]).toMatchObject({ id: "surface", label: "Road surface" });
  });

  test("answers a view wider than its zoom empty without asking a provider", async () => {
    const a = provider("a", [station({ id: "a:1" })]);
    const source = createRoadWeatherDataSource(ctxWith([a]));
    const world = await source.search({ west: -180, south: -85, east: 180, north: 85 });
    expect(world.data).toEqual([]);
    expect(a.searchStations).not.toHaveBeenCalled();
  });

  test("is listed only while a provider is registered", () => {
    expect(createRoadWeatherDataSource(ctxWith([])).isAvailable?.()).toBe(false);
    expect(createRoadWeatherDataSource(ctxWith([provider("a", [])])).isAvailable?.()).toBe(true);
  });

  test("opens a station's detail from the provider that holds it", async () => {
    const source = createRoadWeatherDataSource(ctxWith([provider("a", [station({ id: "a:1" })])]));
    const found = await source.getDetail("a:1");
    expect(found.data?.id).toBe("a:1");
    expect((await source.getDetail("missing")).data).toBeNull();
  });
});
