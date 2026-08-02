import type { BBox, IntegrationContext } from "@openmapx/core";
import { describe, expect, it, vi } from "vitest";
import { activeClosuresForBbox } from "../closures";

type RoadConditionsProvider = {
  id: string;
  getEvents: ReturnType<typeof vi.fn>;
  coverage?: unknown;
};

function makeRoadConditionsCtx(
  providers: RoadConditionsProvider[],
  domain = "road-conditions",
  disallowedSourceIds?: Set<string>,
): IntegrationContext {
  return {
    getIntegrationsByDomain: (d: string) => {
      if (d !== domain) return [];
      return providers.map((p) => ({
        id: p.id,
        providers: new Map<string, unknown[]>([["road-conditions", [p]]]),
      }));
    },
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    ...(disallowedSourceIds ? { getDisallowedSourceIds: async () => disallowedSourceIds } : {}),
  } as unknown as IntegrationContext;
}

const TEST_BBOX: BBox = [-1, 51, 1, 52];

describe("activeClosuresForBbox", () => {
  it("returns empty when no road-conditions integrations are registered", async () => {
    const ctx = makeRoadConditionsCtx([]);
    const result = await activeClosuresForBbox(ctx, TEST_BBOX);
    expect(result.points).toHaveLength(0);
    expect(result.polygons).toHaveLength(0);
  });

  it("converts a Point geometry closure to a points entry", async () => {
    const getEvents = vi.fn().mockResolvedValue([
      {
        id: "test:1",
        source: "test",
        provider: "road-conditions-test",
        type: "road_closure",
        severity: "high",
        geometry: { type: "Point", coordinates: [0.5, 51.5] },
        headline: "Road closed",
      },
    ]);
    const ctx = makeRoadConditionsCtx([{ id: "road-conditions-test", getEvents }]);
    const result = await activeClosuresForBbox(ctx, TEST_BBOX);
    expect(result.points).toEqual([[0.5, 51.5]]);
    expect(result.polygons).toHaveLength(0);
  });

  it("converts a short LineString closure to its vertices (no densification needed)", async () => {
    // Vertices are ~14 m apart — below MAX_EXCLUSION_SPACING_M, so no
    // intermediate points are inserted and the result equals the raw vertices.
    const coords = [
      [0.1, 51.1],
      [0.1001, 51.1001],
      [0.1002, 51.1002],
    ];
    const getEvents = vi.fn().mockResolvedValue([
      {
        id: "test:2",
        source: "test",
        provider: "road-conditions-test",
        type: "lane_closure",
        severity: "high",
        geometry: { type: "LineString", coordinates: coords },
        headline: "Lane closed",
      },
    ]);
    const ctx = makeRoadConditionsCtx([{ id: "road-conditions-test", getEvents }]);
    const result = await activeClosuresForBbox(ctx, TEST_BBOX);
    expect(result.points).toEqual([
      [0.1, 51.1],
      [0.1001, 51.1001],
      [0.1002, 51.1002],
    ]);
    expect(result.polygons).toHaveLength(0);
  });

  it("densifies a long sparse LineString so the result has more than just the endpoints", async () => {
    // Two endpoints ~500 m apart — well above the 45 m max spacing.
    // Densification must insert intermediate points so the whole segment
    // is covered by exclusion markers.
    const coords = [
      [0.1, 51.1],
      [0.1, 51.1045], // ~500 m north of the first point
    ];
    const getEvents = vi.fn().mockResolvedValue([
      {
        id: "test:dense",
        source: "test",
        provider: "road-conditions-test",
        type: "road_closure",
        severity: "high",
        geometry: { type: "LineString", coordinates: coords },
        headline: "Long closure",
      },
    ]);
    const ctx = makeRoadConditionsCtx([{ id: "road-conditions-test", getEvents }]);
    const result = await activeClosuresForBbox(ctx, TEST_BBOX);
    expect(result.points.length).toBeGreaterThan(2);
    // Original endpoints must be among the output.
    expect(result.points[0]).toEqual([0.1, 51.1]);
    expect(result.points[result.points.length - 1]).toEqual([0.1, 51.1045]);
  });

  it("keeps all sampled points for the provider boundary to constrain", async () => {
    // A ~3.3 km LineString densifies to ~74 points. Engine-specific request
    // budgets are enforced by the selected routing adapter, not this generic
    // closure collector.
    const coords = [
      [0.1, 51.1],
      [0.1, 51.13],
    ];
    const getEvents = vi.fn().mockResolvedValue([
      {
        id: "test:cap",
        source: "test",
        provider: "road-conditions-test",
        type: "road_closure",
        severity: "high",
        geometry: { type: "LineString", coordinates: coords },
        headline: "Very long closure",
      },
    ]);
    const ctx = makeRoadConditionsCtx([{ id: "road-conditions-test", getEvents }]);
    const result = await activeClosuresForBbox(ctx, TEST_BBOX);
    expect(result.points.length).toBeGreaterThan(45);
    expect(result.points[0]).toEqual([0.1, 51.1]);
    expect(result.points.at(-1)).toEqual([0.1, 51.13]);
    expect(ctx.log.warn).not.toHaveBeenCalled();
  });

  it("converts a Polygon geometry closure to polygons", async () => {
    const ring = [
      [0.0, 51.0],
      [0.1, 51.0],
      [0.1, 51.1],
      [0.0, 51.1],
      [0.0, 51.0],
    ];
    const getEvents = vi.fn().mockResolvedValue([
      {
        id: "test:3",
        source: "test",
        provider: "road-conditions-test",
        type: "road_closure",
        severity: "critical",
        geometry: { type: "Polygon", coordinates: [ring] },
        headline: "Area closed",
      },
    ]);
    const ctx = makeRoadConditionsCtx([{ id: "road-conditions-test", getEvents }]);
    const result = await activeClosuresForBbox(ctx, TEST_BBOX);
    expect(result.polygons).toHaveLength(1);
    expect(result.polygons[0]).toEqual(ring);
    expect(result.points).toHaveLength(0);
  });

  it("includes critical-severity events even when type is not a closure type", async () => {
    const getEvents = vi.fn().mockResolvedValue([
      {
        id: "test:4",
        source: "test",
        provider: "road-conditions-test",
        type: "accident",
        severity: "critical",
        geometry: { type: "Point", coordinates: [0.5, 51.5] },
        headline: "Critical accident",
      },
    ]);
    const ctx = makeRoadConditionsCtx([{ id: "road-conditions-test", getEvents }]);
    const result = await activeClosuresForBbox(ctx, TEST_BBOX);
    expect(result.points).toEqual([[0.5, 51.5]]);
  });

  it("skips events with roadState open", async () => {
    const getEvents = vi.fn().mockResolvedValue([
      {
        id: "test:5",
        source: "test",
        provider: "road-conditions-test",
        type: "road_closure",
        severity: "high",
        roadState: "open",
        geometry: { type: "Point", coordinates: [0.5, 51.5] },
        headline: "Previously closed — now open",
      },
    ]);
    const ctx = makeRoadConditionsCtx([{ id: "road-conditions-test", getEvents }]);
    const result = await activeClosuresForBbox(ctx, TEST_BBOX);
    expect(result.points).toHaveLength(0);
  });

  it("merges closures from multiple providers with allSettled (ignores failures)", async () => {
    const good = vi.fn().mockResolvedValue([
      {
        id: "good:1",
        source: "good",
        provider: "good",
        type: "road_closure",
        severity: "high",
        geometry: { type: "Point", coordinates: [0.1, 51.1] },
        headline: "Closed",
      },
    ]);
    const bad = vi.fn().mockRejectedValue(new Error("provider down"));
    const ctx = makeRoadConditionsCtx([
      { id: "road-conditions-good", getEvents: good },
      { id: "road-conditions-bad", getEvents: bad },
    ]);
    const result = await activeClosuresForBbox(ctx, TEST_BBOX);
    expect(result.points).toEqual([[0.1, 51.1]]);
  });

  it("calls getEvents with closure types and no severity floor", async () => {
    // A medium-severity lane_closure (OC's derived default when no severity is
    // declared) must reach isClosure() rather than being pre-filtered by the
    // provider query — road/lane closures are route-blocking regardless of
    // severity.
    const getEvents = vi.fn().mockResolvedValue([]);
    const ctx = makeRoadConditionsCtx([{ id: "road-conditions-test", getEvents }]);
    await activeClosuresForBbox(ctx, TEST_BBOX);
    expect(getEvents).toHaveBeenCalledWith(TEST_BBOX, {
      types: ["road_closure", "lane_closure"],
    });
  });

  it("includes a medium-severity lane_closure as a routing exclusion", async () => {
    // The mock HONORS the `minSeverity` it is passed, exactly as a real provider
    // does — so this test only passes when the query omits the "high" floor.
    // Reinstating `minSeverity: "high"` drops the medium event here and turns
    // this test RED, making it genuinely diagnostic of the fix.
    const SEVERITY_RANK: Record<string, number> = { low: 0, medium: 1, high: 2, critical: 3 };
    const event = {
      id: "test:medium-lane",
      source: "test",
      provider: "test",
      type: "lane_closure",
      severity: "medium",
      geometry: { type: "Point", coordinates: [0.5, 51.5] },
      headline: "Lane closed",
    };
    const getEvents = vi.fn(async (_bbox: BBox, opts?: { minSeverity?: string }) => {
      const floor = opts?.minSeverity;
      if (floor && (SEVERITY_RANK[event.severity] ?? 0) < (SEVERITY_RANK[floor] ?? 0)) return [];
      return [event];
    });
    const ctx = makeRoadConditionsCtx([{ id: "road-conditions-test", getEvents }]);
    const result = await activeClosuresForBbox(ctx, TEST_BBOX);
    expect(result.points).toEqual([[0.5, 51.5]]);
  });

  it("does not exclude a non-closure event at a non-critical severity", async () => {
    const getEvents = vi.fn().mockResolvedValue([
      {
        id: "test:non-closure",
        source: "test",
        provider: "test",
        type: "accident",
        severity: "medium",
        geometry: { type: "Point", coordinates: [0.5, 51.5] },
        headline: "Minor accident",
      },
    ]);
    const ctx = makeRoadConditionsCtx([{ id: "road-conditions-test", getEvents }]);
    const result = await activeClosuresForBbox(ctx, TEST_BBOX);
    expect(result.points).toHaveLength(0);
  });

  it("excludes closures whose source the operator has disallowed", async () => {
    const getEvents = vi.fn().mockResolvedValue([
      {
        id: "blocked:1",
        source: "blocked-feed",
        provider: "test",
        type: "road_closure",
        severity: "high",
        geometry: { type: "Point", coordinates: [0.5, 51.5] },
        headline: "Closed",
      },
    ]);
    const ctx = makeRoadConditionsCtx(
      [{ id: "road-conditions-test", getEvents }],
      "road-conditions",
      new Set(["blocked-feed"]),
    );
    const result = await activeClosuresForBbox(ctx, TEST_BBOX);
    expect(result.points).toHaveLength(0);
  });

  it("still includes closures from allowed sources when other sources are disallowed", async () => {
    const getEvents = vi.fn().mockResolvedValue([
      {
        id: "allowed:1",
        source: "allowed-feed",
        provider: "test",
        type: "road_closure",
        severity: "high",
        geometry: { type: "Point", coordinates: [0.5, 51.5] },
        headline: "Closed",
      },
    ]);
    const ctx = makeRoadConditionsCtx(
      [{ id: "road-conditions-test", getEvents }],
      "road-conditions",
      new Set(["blocked-feed"]),
    );
    const result = await activeClosuresForBbox(ctx, TEST_BBOX);
    expect(result.points).toEqual([[0.5, 51.5]]);
  });

  it("treats an absent getDisallowedSourceIds method as no sources disallowed", async () => {
    const getEvents = vi.fn().mockResolvedValue([
      {
        id: "test:no-policy",
        source: "test",
        provider: "test",
        type: "road_closure",
        severity: "high",
        geometry: { type: "Point", coordinates: [0.5, 51.5] },
        headline: "Closed",
      },
    ]);
    const ctx = makeRoadConditionsCtx([{ id: "road-conditions-test", getEvents }]);
    expect(ctx.getDisallowedSourceIds).toBeUndefined();
    const result = await activeClosuresForBbox(ctx, TEST_BBOX);
    expect(result.points).toEqual([[0.5, 51.5]]);
  });

  it("handles MultiLineString geometry by densifying all lines into points", async () => {
    // Each line has vertices ~14 m apart (below the 45 m threshold), so no
    // intermediate points are inserted and the result covers both lines.
    const getEvents = vi.fn().mockResolvedValue([
      {
        id: "test:ml",
        source: "test",
        provider: "test",
        type: "road_closure",
        severity: "high",
        geometry: {
          type: "MultiLineString",
          coordinates: [
            [
              [0.0, 51.0],
              [0.0001, 51.0001],
            ],
            [
              [0.2, 51.2],
              [0.2001, 51.2001],
            ],
          ],
        },
        headline: "Multi-segment closure",
      },
    ]);
    const ctx = makeRoadConditionsCtx([{ id: "road-conditions-test", getEvents }]);
    const result = await activeClosuresForBbox(ctx, TEST_BBOX);
    expect(result.points).toEqual([
      [0.0, 51.0],
      [0.0001, 51.0001],
      [0.2, 51.2],
      [0.2001, 51.2001],
    ]);
  });

  it("handles MultiPoint geometry by pushing each point as its own exclusion (no centroid)", async () => {
    // DATEX2 "closure between junction X and Y" is emitted as a MultiPoint of
    // the two ends — collapsing to a centroid could land off-road, so each
    // point must reach the router individually.
    const getEvents = vi.fn().mockResolvedValue([
      {
        id: "test:mpt",
        source: "test",
        provider: "test",
        type: "road_closure",
        severity: "high",
        geometry: {
          type: "MultiPoint",
          coordinates: [
            [12.0, 49.0],
            [12.2, 49.2],
          ],
        },
        headline: "Closure between junction X and Y",
      },
    ]);
    const ctx = makeRoadConditionsCtx([{ id: "road-conditions-test", getEvents }]);
    const result = await activeClosuresForBbox(ctx, TEST_BBOX);
    expect(result.points).toEqual([
      [12.0, 49.0],
      [12.2, 49.2],
    ]);
    expect(result.polygons).toHaveLength(0);
  });

  it("handles GeometryCollection geometry by recursing into every member geometry", async () => {
    const getEvents = vi.fn().mockResolvedValue([
      {
        id: "test:gc",
        source: "test",
        provider: "test",
        type: "road_closure",
        severity: "high",
        geometry: {
          type: "GeometryCollection",
          geometries: [
            { type: "Point", coordinates: [0.5, 51.5] },
            {
              type: "LineString",
              coordinates: [
                [0.1, 51.1],
                [0.1001, 51.1001],
              ],
            },
          ],
        },
        headline: "Collection closure",
      },
    ]);
    const ctx = makeRoadConditionsCtx([{ id: "road-conditions-test", getEvents }]);
    const result = await activeClosuresForBbox(ctx, TEST_BBOX);
    expect(result.points).toEqual([
      [0.5, 51.5],
      [0.1, 51.1],
      [0.1001, 51.1001],
    ]);
    expect(result.polygons).toHaveLength(0);
  });

  it("handles MultiPolygon geometry by pushing each outer ring", async () => {
    const ring1 = [
      [0.0, 51.0],
      [0.1, 51.0],
      [0.1, 51.1],
      [0.0, 51.0],
    ];
    const ring2 = [
      [0.5, 51.5],
      [0.6, 51.5],
      [0.6, 51.6],
      [0.5, 51.5],
    ];
    const getEvents = vi.fn().mockResolvedValue([
      {
        id: "test:mp",
        source: "test",
        provider: "test",
        type: "road_closure",
        severity: "high",
        geometry: {
          type: "MultiPolygon",
          coordinates: [[ring1], [ring2]],
        },
        headline: "Multi-area closure",
      },
    ]);
    const ctx = makeRoadConditionsCtx([{ id: "road-conditions-test", getEvents }]);
    const result = await activeClosuresForBbox(ctx, TEST_BBOX);
    expect(result.polygons).toHaveLength(2);
    expect(result.polygons[0]).toEqual(ring1);
    expect(result.polygons[1]).toEqual(ring2);
  });

  describe("origin-aware routing gate (crowd non-routing events are dropped)", () => {
    it("drops a crowd road_closure that is not routingEligible", async () => {
      const getEvents = vi.fn().mockResolvedValue([
        {
          id: "crowd:1",
          source: "openconditions",
          provider: "road-conditions-openconditions",
          type: "road_closure",
          severity: "high",
          geometry: { type: "Point", coordinates: [0.5, 51.5] },
          headline: "User-reported closure",
          originKind: "crowd",
          routingEligible: false,
        },
      ]);
      const ctx = makeRoadConditionsCtx([{ id: "road-conditions-openconditions", getEvents }]);
      const result = await activeClosuresForBbox(ctx, TEST_BBOX);
      expect(result.points).toHaveLength(0);
    });

    it("drops a crowd road_closure whose routingEligible is undefined", async () => {
      const getEvents = vi.fn().mockResolvedValue([
        {
          id: "crowd:2",
          source: "openconditions",
          provider: "road-conditions-openconditions",
          type: "road_closure",
          severity: "high",
          geometry: { type: "Point", coordinates: [0.5, 51.5] },
          headline: "User-reported closure",
          originKind: "crowd",
        },
      ]);
      const ctx = makeRoadConditionsCtx([{ id: "road-conditions-openconditions", getEvents }]);
      const result = await activeClosuresForBbox(ctx, TEST_BBOX);
      expect(result.points).toHaveLength(0);
    });

    it("keeps a crowd road_closure once it is routingEligible", async () => {
      const getEvents = vi.fn().mockResolvedValue([
        {
          id: "crowd:3",
          source: "openconditions",
          provider: "road-conditions-openconditions",
          type: "road_closure",
          severity: "high",
          geometry: { type: "Point", coordinates: [0.5, 51.5] },
          headline: "Externally-confirmed closure",
          originKind: "crowd",
          routingEligible: true,
        },
      ]);
      const ctx = makeRoadConditionsCtx([{ id: "road-conditions-openconditions", getEvents }]);
      const result = await activeClosuresForBbox(ctx, TEST_BBOX);
      expect(result.points).toEqual([[0.5, 51.5]]);
    });

    it("keeps a feed road_closure regardless of routingEligible", async () => {
      const getEvents = vi.fn().mockResolvedValue([
        {
          id: "feed:1",
          source: "ndw",
          provider: "road-conditions-openconditions",
          type: "road_closure",
          severity: "high",
          geometry: { type: "Point", coordinates: [0.5, 51.5] },
          headline: "Official closure",
          originKind: "feed",
        },
      ]);
      const ctx = makeRoadConditionsCtx([{ id: "road-conditions-openconditions", getEvents }]);
      const result = await activeClosuresForBbox(ctx, TEST_BBOX);
      expect(result.points).toEqual([[0.5, 51.5]]);
    });

    it("keeps a closure with no originKind (fail-open on unknown origin — never regress official events)", async () => {
      // Third-party providers (TomTom/HERE) never stamp originKind; dropping
      // their closures would route a car into a real closed road. Only an
      // explicit crowd-non-routing event is withheld.
      const getEvents = vi.fn().mockResolvedValue([
        {
          id: "unknown:1",
          source: "tomtom",
          provider: "road-conditions-tomtom",
          type: "road_closure",
          severity: "high",
          geometry: { type: "Point", coordinates: [0.5, 51.5] },
          headline: "Closure from a provider that does not stamp originKind",
        },
      ]);
      const ctx = makeRoadConditionsCtx([{ id: "road-conditions-tomtom", getEvents }]);
      const result = await activeClosuresForBbox(ctx, TEST_BBOX);
      expect(result.points).toEqual([[0.5, 51.5]]);
    });
  });

  describe("time-aware filtering (validFrom/validTo vs travel time)", () => {
    // Planned closure in effect 2026-07-10 22:00 → 2026-07-13 05:00 (CEST).
    const plannedClosure = {
      id: "planned:1",
      source: "test",
      provider: "road-conditions-test",
      type: "road_closure",
      severity: "high",
      geometry: { type: "Point", coordinates: [0.5, 51.5] },
      headline: "Planned closure",
      validFrom: "2026-07-10T22:00:00+02:00",
      validTo: "2026-07-13T05:00:00+02:00",
    };

    it("skips a closure that has not started by the requested travel time", async () => {
      const getEvents = vi.fn().mockResolvedValue([plannedClosure]);
      const ctx = makeRoadConditionsCtx([{ id: "road-conditions-test", getEvents }]);
      const result = await activeClosuresForBbox(ctx, TEST_BBOX, new Date("2026-07-01T08:00:00Z"));
      expect(result.points).toHaveLength(0);
    });

    it("includes the closure when the travel time falls inside its window", async () => {
      const getEvents = vi.fn().mockResolvedValue([plannedClosure]);
      const ctx = makeRoadConditionsCtx([{ id: "road-conditions-test", getEvents }]);
      const result = await activeClosuresForBbox(ctx, TEST_BBOX, new Date("2026-07-11T08:00:00Z"));
      expect(result.points).toEqual([[0.5, 51.5]]);
    });

    it("skips a closure whose window already ended by the travel time", async () => {
      const getEvents = vi.fn().mockResolvedValue([plannedClosure]);
      const ctx = makeRoadConditionsCtx([{ id: "road-conditions-test", getEvents }]);
      const result = await activeClosuresForBbox(ctx, TEST_BBOX, new Date("2026-07-20T08:00:00Z"));
      expect(result.points).toHaveLength(0);
    });

    it("always includes an unbounded (ongoing, no validFrom/validTo) closure", async () => {
      const getEvents = vi.fn().mockResolvedValue([
        {
          id: "ongoing:1",
          source: "test",
          provider: "road-conditions-test",
          type: "road_closure",
          severity: "high",
          geometry: { type: "Point", coordinates: [0.5, 51.5] },
          headline: "Ongoing construction",
        },
      ]);
      const ctx = makeRoadConditionsCtx([{ id: "road-conditions-test", getEvents }]);
      const result = await activeClosuresForBbox(ctx, TEST_BBOX, new Date("2026-07-01T08:00:00Z"));
      expect(result.points).toEqual([[0.5, 51.5]]);
    });
  });

  describe("recurring schedule (nightly windows supersede the outer span)", () => {
    // Nightly 20:00–05:00 Europe/Berlin (CEST +02:00 in summer) over 29 Jun–1 Jul.
    // Each occurrence = 20:00 local (18:00Z) for 9h → ends 03:00Z next day.
    const nightly = {
      id: "nightly:1",
      source: "test",
      provider: "road-conditions-test",
      type: "road_closure",
      severity: "high",
      geometry: { type: "Point", coordinates: [0.5, 51.5] },
      headline: "Nightly closure",
      validFrom: "2026-06-29T18:00:00.000Z",
      validTo: "2026-07-02T03:00:00.000Z",
      schedule: [
        {
          repeatFrequency: "P1D",
          startDate: "2026-06-29",
          endDate: "2026-07-01",
          startTime: "20:00",
          duration: "PT9H",
          scheduleTimezone: "Europe/Berlin",
        },
      ],
    };
    const run = (at: string) => {
      const getEvents = vi.fn().mockResolvedValue([nightly]);
      const ctx = makeRoadConditionsCtx([{ id: "road-conditions-test", getEvents }]);
      return activeClosuresForBbox(ctx, TEST_BBOX, new Date(at));
    };

    it("avoids the closure at night (inside a window)", async () => {
      // 23:00Z = 01:00 Berlin on Jul 1 — inside the Jun-30 night window.
      expect((await run("2026-06-30T23:00:00Z")).points).toEqual([[0.5, 51.5]]);
    });

    it("does NOT avoid it during the day, even within the outer from–to span", async () => {
      // 14:00Z = 16:00 Berlin — between windows.
      expect((await run("2026-06-30T14:00:00Z")).points).toHaveLength(0);
    });

    it("avoids the early-morning tail of an overnight window (attributed to the prior day)", async () => {
      // 02:00Z Jul 1 = 04:00 Berlin — still inside the Jun-30 night window (→03:00Z).
      expect((await run("2026-07-01T02:00:00Z")).points).toEqual([[0.5, 51.5]]);
    });

    it("does NOT avoid it on a night outside the window's date range", async () => {
      expect((await run("2026-07-15T23:00:00Z")).points).toHaveLength(0);
    });
  });
});
