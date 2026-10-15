import type { BoundingBox } from "@openmapx/core";
import type {
  BorderCrossing,
  BorderCrossingProvider,
  IntegrationContext,
} from "@openmapx/integration-framework";
import { describe, expect, test, vi } from "vitest";
import { createBorderCrossingDataSource } from "../data-source.js";

/** A box a map at zoom 8 shows over Niagara. */
const BBOX: BoundingBox = { west: -80, south: 42.5, east: -78.5, north: 43.5 };

function crossing(over: Partial<BorderCrossing> & Pick<BorderCrossing, "id">): BorderCrossing {
  return {
    name: `Crossing ${over.id}`,
    coordinates: [-78.9, 42.9],
    countries: ["CA", "US"],
    queues: [
      { key: "p", mode: "passenger", to: "US", status: "delay", waitMinutes: 10, stale: false },
    ],
    sources: ["src-a"],
    attributions: [{ sourceId: "src-a", name: "Source A" }],
    ...over,
  };
}

function provider(
  id: string,
  crossings: BorderCrossing[] | Error,
  over: Partial<BorderCrossingProvider> = {},
): BorderCrossingProvider {
  return {
    id,
    searchCrossings: vi.fn(async () => {
      if (crossings instanceof Error) throw crossings;
      return { crossings };
    }),
    getCrossing: vi.fn(async (crossingId: string) =>
      crossings instanceof Error ? null : (crossings.find((c) => c.id === crossingId) ?? null),
    ),
    ...over,
  };
}

/** A context over `providers` under the `border-crossings` domain. */
function ctxWith(
  providers: BorderCrossingProvider[],
  opts: { disallowed?: string[] } = {},
): IntegrationContext {
  const quiet = (): void => {};
  return {
    getIntegrationsByDomain: (domain: string) =>
      domain === "border-crossings"
        ? providers.map((p) => ({
            id: p.id,
            providers: new Map<string, BorderCrossingProvider[]>([["border-crossings", [p]]]),
          }))
        : [],
    getDisallowedSourceIds: opts.disallowed ? async () => new Set(opts.disallowed) : undefined,
    log: { warn: quiet, error: quiet, info: quiet, debug: quiet },
  } as unknown as IntegrationContext;
}

describe("border-crossings data source", () => {
  test("merges providers, survives one failing, and passes a partial reason through", async () => {
    const a = provider("a", [crossing({ id: "a:1" }), crossing({ id: "a:2" })]);
    const source = createBorderCrossingDataSource(
      ctxWith([
        a,
        provider("b", new Error("upstream down")),
        provider("c", [], {
          searchCrossings: vi.fn(async () => ({
            crossings: [crossing({ id: "c:1", sources: ["src-c"] })],
            partial: "area" as const,
          })),
        }),
      ]),
    );

    const result = await source.search(BBOX);

    expect(result.data.map((r) => r.id)).toEqual(["a:1", "a:2", "c:1"]);
    expect(result.partial).toBe("area");
    expect(a.searchCrossings).toHaveBeenCalledWith([-80, 42.5, -78.5, 43.5], expect.any(Object));
    expect(source.id).toBe("border-crossings");
    expect(source.attribution).toEqual([]);
  });

  test("keeps out a crossing of a source the operator disallows", async () => {
    const source = createBorderCrossingDataSource(
      ctxWith(
        [provider("a", [crossing({ id: "a:1" }), crossing({ id: "a:2", sources: ["src-x"] })])],
        { disallowed: ["src-x"] },
      ),
    );
    expect((await source.search(BBOX)).data.map((r) => r.id)).toEqual(["a:1"]);
  });

  test("filters by how long the wait is", async () => {
    const wait = (waitMinutes: number) => [
      {
        key: "p",
        mode: "passenger" as const,
        to: "US",
        status: "delay" as const,
        waitMinutes,
        stale: false,
      },
    ];
    const source = createBorderCrossingDataSource(
      ctxWith([
        provider("a", [
          crossing({ id: "short", queues: wait(5) }),
          crossing({ id: "long", queues: wait(70) }),
          crossing({ id: "closed", open: "closed" }),
        ]),
      ]),
    );
    const bad = await source.search(BBOX, { wait: ["long", "closed"] });
    expect(bad.data.map((r) => r.id)).toEqual(["long", "closed"]);
    expect((await source.getFilters())[0]).toMatchObject({ id: "wait", label: "Wait time" });
  });

  test("answers a view wider than its zoom empty without asking a provider", async () => {
    const a = provider("a", [crossing({ id: "a:1" })]);
    const source = createBorderCrossingDataSource(ctxWith([a]));
    const world = await source.search({ west: -180, south: -85, east: 180, north: 85 });
    expect(world.data).toEqual([]);
    expect(a.searchCrossings).not.toHaveBeenCalled();
  });

  test("is listed only while a provider is registered", () => {
    expect(createBorderCrossingDataSource(ctxWith([])).isAvailable?.()).toBe(false);
    expect(createBorderCrossingDataSource(ctxWith([provider("a", [])])).isAvailable?.()).toBe(true);
  });

  test("opens a crossing's detail from the provider that holds it", async () => {
    const source = createBorderCrossingDataSource(
      ctxWith([provider("a", [crossing({ id: "a:1" })])]),
    );
    const found = await source.getDetail("a:1");
    expect(found.data?.id).toBe("a:1");
    expect((await source.getDetail("missing")).data).toBeNull();
  });
});
