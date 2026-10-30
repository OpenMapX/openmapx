import type { LngLat, Route, RoutingOptions } from "@openmapx/core";
import { describe, expect, it, vi } from "vitest";
import {
  closuresOnRoutes,
  MAX_DIRECTED_EXCLUSIONS,
  plannedClosureImpact,
  routeAroundPlannedClosures,
  routesBox,
} from "./planned-closures.js";

/** A road due north along 6.8 E, sampled every ~100 m from 51.2 N. */
const northbound = (id: string, from = 51.2, count = 3, localAccess = false) => ({
  id,
  source: "fr",
  localAccess,
  validUntil: "2026-09-11T12:10:00.000Z",
  samples: Array.from({ length: count }, (_, i) => ({
    lon: 6.8,
    lat: from + i * 0.0009,
    heading: 0,
  })),
});

const route = (geometry: LngLat[]): Route => ({ geometry }) as unknown as Route;
const NORTH = route([
  [6.8, 51.199],
  [6.8, 51.21],
]);
const SOUTH = route([
  [6.8, 51.21],
  [6.8, 51.199],
]);
/** A parallel road 200 m east, clear of the closure. */
const DETOUR = route([
  [6.8, 51.199],
  [6.803, 51.199],
  [6.803, 51.21],
]);

describe("closuresOnRoutes", () => {
  it("finds a route travelling the closed direction, and only that direction", () => {
    const closure = northbound("c1");
    expect(closuresOnRoutes([NORTH], [closure]).get("c1")).toHaveLength(3);
    expect(closuresOnRoutes([SOUTH], [closure]).size).toBe(0);
    expect(closuresOnRoutes([DETOUR], [closure]).size).toBe(0);
  });

  it("collects the samples every route passed", () => {
    const hits = closuresOnRoutes(
      [
        NORTH,
        route([
          [6.8, 51.1991],
          [6.8, 51.2005],
        ]),
      ],
      [northbound("c1")],
    );
    expect(hits.get("c1")).toHaveLength(3);
  });
});

describe("routeAroundPlannedClosures", () => {
  const options: RoutingOptions = { departAt: "2026-09-12T08:00" };

  it("plans again with the passed samples as directed exclusions", async () => {
    const plan = vi.fn(async (_: RoutingOptions) => ({ routes: [DETOUR] }));
    const out = await routeAroundPlannedClosures({
      first: { routes: [NORTH] },
      closures: [northbound("c1")],
      waypoints: [
        [6.8, 51.19],
        [6.8, 51.22],
      ],
      options,
      plan,
    });
    expect(plan).toHaveBeenCalledTimes(1);
    const directed = plan.mock.calls[0]?.[0].directedExclusions ?? [];
    expect(directed.map((d) => d.heading)).toEqual([0, 0, 0]);
    expect(directed.map((d) => d.point[1])).toEqual([
      expect.closeTo(51.2, 7),
      expect.closeTo(51.2009, 7),
      expect.closeTo(51.2018, 7),
    ]);
    expect(plan.mock.calls[0]?.[0].departAt).toBe("2026-09-12T08:00");
    expect(out).toMatchObject({ excluded: ["c1"], onRoute: [] });
    expect(out.result.routes[0]).toBe(DETOUR);
  });

  it("does not plan again when no route travels a closure", async () => {
    const plan = vi.fn();
    const out = await routeAroundPlannedClosures({
      first: { routes: [SOUTH] },
      closures: [northbound("c1")],
      waypoints: [],
      options,
      plan,
    });
    expect(plan).not.toHaveBeenCalled();
    expect(out).toMatchObject({ excluded: [], onRoute: [] });
  });

  it("reports a closure still on the route after its rounds", async () => {
    const plan = vi.fn(async () => ({ routes: [NORTH] }));
    const closure = northbound("c1");
    const out = await routeAroundPlannedClosures({
      first: { routes: [NORTH] },
      closures: [closure],
      waypoints: [],
      options,
      plan,
    });
    // The same samples come back each round, so nothing new is excluded after the first.
    expect(plan).toHaveBeenCalledTimes(1);
    expect(out.onRoute).toEqual(["c1"]);
    expect(out.excluded).toEqual([]);
  });

  it("stops at the directed-exclusion budget rather than dropping points", async () => {
    const plan = vi.fn();
    const big = northbound("big", 51.2, MAX_DIRECTED_EXCLUSIONS + 1);
    const long = route([
      [6.8, 51.199],
      [6.8, 51.3],
    ]);
    const out = await routeAroundPlannedClosures({
      first: { routes: [long] },
      closures: [big],
      waypoints: [],
      options,
      plan,
    });
    expect(plan).not.toHaveBeenCalled();
    expect(out.onRoute).toEqual(["big"]);
  });

  it("keeps the previous route when the exclusions leave no path", async () => {
    const plan = vi.fn(async () => {
      throw new Error("No path could be found for input");
    });
    const out = await routeAroundPlannedClosures({
      first: { routes: [NORTH] },
      closures: [northbound("c1")],
      waypoints: [],
      options,
      plan,
    });
    expect(plan).toHaveBeenCalledOnce();
    expect(out.result.routes[0]).toBe(NORTH);
    expect(out).toMatchObject({ excluded: [], onRoute: ["c1"] });
  });

  it("never excludes a sample at the trip's own start or destination", async () => {
    const plan = vi.fn(async (_: RoutingOptions) => ({ routes: [DETOUR] }));
    await routeAroundPlannedClosures({
      first: { routes: [NORTH] },
      closures: [northbound("c1")],
      waypoints: [
        [6.8, 51.2],
        [6.8, 51.22],
      ],
      options,
      plan,
    });
    const points = plan.mock.calls[0]?.[0].directedExclusions?.map((d) => d.point[1]);
    expect(points).toEqual([expect.closeTo(51.2018, 7)]);
  });

  it("leaves a local-access road open where the trip starts or ends on it", async () => {
    const plan = vi.fn();
    const out = await routeAroundPlannedClosures({
      first: { routes: [NORTH] },
      closures: [northbound("local", 51.2, 3, true)],
      waypoints: [
        [6.8, 51.199],
        [6.8, 51.2012],
      ],
      options,
      plan,
    });
    expect(plan).not.toHaveBeenCalled();
    expect(out).toMatchObject({ excluded: [], onRoute: [] });
  });
});

describe("plannedClosureImpact", () => {
  const base = {
    availability: "unsupported" as const,
    evaluatedAt: "2026-09-11T12:00:00.000Z",
    validUntil: null,
    reasons: ["unsupported_future_shared_traffic"],
  };

  it("records avoided closures without claiming more", () => {
    expect(
      plannedClosureImpact(base, { kind: "applied", excluded: 2, onRoute: 0, unrepresentable: 0 }),
    ).toEqual({
      ...base,
      reasons: ["unsupported_future_shared_traffic", "planned_closures_avoided"],
    });
  });

  it("limits a route still on a closure", () => {
    expect(
      plannedClosureImpact(base, { kind: "applied", excluded: 0, onRoute: 1, unrepresentable: 1 }),
    ).toMatchObject({
      availability: "limited",
      reasons: expect.arrayContaining([
        "planned_closure_on_route",
        "planned_closures_unrepresentable",
      ]),
    });
  });

  it("names an unavailable or shadow evaluation", () => {
    expect(plannedClosureImpact(base, { kind: "unavailable" }).reasons).toContain(
      "planned_closures_unavailable",
    );
    expect(plannedClosureImpact(base, { kind: "shadow", onRoute: 1 }).reasons).toContain(
      "planned_closures_shadow",
    );
    expect(plannedClosureImpact(base, { kind: "shadow", onRoute: 0 })).toEqual(base);
  });
});

describe("routesBox", () => {
  it("bounds every route with a margin, and is null without geometry", () => {
    expect(routesBox([NORTH, DETOUR])).toEqual([
      expect.closeTo(6.78, 9),
      expect.closeTo(51.179, 9),
      expect.closeTo(6.823, 9),
      expect.closeTo(51.23, 9),
    ]);
    expect(routesBox([route([])])).toBeNull();
  });
});
