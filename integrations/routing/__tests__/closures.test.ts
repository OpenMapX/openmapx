import type { BBox, RoadConditionEvent } from "@openmapx/core";
import type { IntegrationContext } from "@openmapx/integration-framework";
import { describe, expect, it, vi } from "vitest";
import { activeClosuresForBbox } from "../closures";
import { boundEvent, effect, roadConditionEvent } from "./support/road-condition";

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
    getRequiredService: () => ({
      serviceId: "data-manager",
      url: "http://data-manager:4000",
      enabled: true,
    }),
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

/** A situation that closes its road, at `geometry` unless said otherwise. */
const closureAt = (
  geometry: RoadConditionEvent["geometry"],
  overrides: Partial<RoadConditionEvent> = {},
): RoadConditionEvent => roadConditionEvent({ geometry, ...overrides });

const point = (lng: number, lat: number): RoadConditionEvent["geometry"] => ({
  type: "Point",
  coordinates: [lng, lat],
});

async function run(events: RoadConditionEvent[], at?: Date) {
  const getEvents = vi.fn().mockResolvedValue(events);
  const ctx = makeRoadConditionsCtx([{ id: "road-conditions-test", getEvents }]);
  return activeClosuresForBbox(ctx, TEST_BBOX, at);
}

describe("activeClosuresForBbox", () => {
  it("returns empty when no road-conditions integrations are registered", async () => {
    const ctx = makeRoadConditionsCtx([]);
    const result = await activeClosuresForBbox(ctx, TEST_BBOX);
    expect(result.points).toHaveLength(0);
    expect(result.polygons).toHaveLength(0);
  });

  it("converts a Point geometry closure to a points entry", async () => {
    const result = await run([closureAt(point(0.5, 51.5))]);
    expect(result.points).toEqual([[0.5, 51.5]]);
    expect(result.polygons).toHaveLength(0);
  });

  it("never stands raw geometry in for a binding when the provider publishes evidence", async () => {
    // OpenConditions sends an evidence map with every situation; an effect
    // without an entry is unbound, stale or unlicensed for routing.
    const result = await run([{ ...closureAt(point(0.5, 51.5)), routingEvidence: {} }]);
    expect(result.points).toHaveLength(0);
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
    const result = await run([closureAt({ type: "LineString", coordinates: coords })]);
    expect(result.points).toEqual(coords);
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
    const result = await run([closureAt({ type: "LineString", coordinates: coords })]);
    expect(result.points.length).toBeGreaterThan(2);
    // Original endpoints must be among the output.
    expect(result.points[0]).toEqual([0.1, 51.1]);
    expect(result.points[result.points.length - 1]).toEqual([0.1, 51.1045]);
  });

  it("keeps all sampled points for the provider boundary to constrain", async () => {
    // A ~3.3 km LineString densifies to ~74 points. Engine-specific request
    // budgets are enforced by the selected routing adapter, not this generic
    // closure collector.
    const getEvents = vi.fn().mockResolvedValue([
      closureAt({
        type: "LineString",
        coordinates: [
          [0.1, 51.1],
          [0.1, 51.13],
        ],
      }),
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
    const result = await run([closureAt({ type: "Polygon", coordinates: [ring] })]);
    expect(result.polygons).toHaveLength(1);
    expect(result.polygons[0]).toEqual(ring);
    expect(result.points).toHaveLength(0);
  });

  it("does not exclude a situation without a closing effect, however severe", async () => {
    const result = await run([
      closureAt(point(0.5, 51.5), {
        kind: "incident",
        type: "accident",
        severity: { label: "critical" },
        effects: [effect("test:1/delay", "delay", { delay: { value: 1800, unit: "s" } })],
      }),
    ]);
    expect(result.points).toHaveLength(0);
  });

  it("does not exclude a lane restriction that leaves lanes open", async () => {
    const result = await run([
      closureAt(point(0.5, 51.5), {
        effects: [
          effect("test:1/lanes", "lane_restriction", {
            lanesTotal: 3,
            lanesClosed: 1,
            vehicleImpact: "some_lanes_closed",
          }),
        ],
      }),
    ]);
    expect(result.points).toHaveLength(0);
  });

  it("excludes a lane restriction that closes every lane, whatever the severity", async () => {
    const result = await run([
      closureAt(point(0.5, 51.5), {
        severity: { label: "minor" },
        effects: [
          effect("test:1/lanes", "lane_restriction", { vehicleImpact: "all_lanes_closed" }),
        ],
      }),
    ]);
    expect(result.points).toEqual([[0.5, 51.5]]);
  });

  it("merges closures from multiple providers with allSettled (ignores failures)", async () => {
    const good = vi.fn().mockResolvedValue([closureAt(point(0.1, 51.1), { source: "good" })]);
    const bad = vi.fn().mockRejectedValue(new Error("provider down"));
    const ctx = makeRoadConditionsCtx([
      { id: "road-conditions-good", getEvents: good },
      { id: "road-conditions-bad", getEvents: bad },
    ]);
    const result = await activeClosuresForBbox(ctx, TEST_BBOX);
    expect(result.points).toEqual([[0.1, 51.1]]);
  });

  it("loads every situation without a severity floor or kind filter", async () => {
    const getEvents = vi.fn().mockResolvedValue([]);
    const ctx = makeRoadConditionsCtx([{ id: "road-conditions-test", getEvents }]);
    await activeClosuresForBbox(ctx, TEST_BBOX);
    expect(getEvents).toHaveBeenCalledWith(TEST_BBOX, {});
  });

  it("excludes closures whose source the operator has disallowed", async () => {
    const getEvents = vi
      .fn()
      .mockResolvedValue([closureAt(point(0.5, 51.5), { source: "blocked-feed" })]);
    const ctx = makeRoadConditionsCtx(
      [{ id: "road-conditions-test", getEvents }],
      "road-conditions",
      new Set(["blocked-feed"]),
    );
    const result = await activeClosuresForBbox(ctx, TEST_BBOX);
    expect(result.points).toHaveLength(0);
  });

  it("still includes closures from allowed sources when other sources are disallowed", async () => {
    const getEvents = vi
      .fn()
      .mockResolvedValue([closureAt(point(0.5, 51.5), { source: "allowed-feed" })]);
    const ctx = makeRoadConditionsCtx(
      [{ id: "road-conditions-test", getEvents }],
      "road-conditions",
      new Set(["blocked-feed"]),
    );
    const result = await activeClosuresForBbox(ctx, TEST_BBOX);
    expect(result.points).toEqual([[0.5, 51.5]]);
  });

  it("treats an absent getDisallowedSourceIds method as no sources disallowed", async () => {
    const getEvents = vi.fn().mockResolvedValue([closureAt(point(0.5, 51.5))]);
    const ctx = makeRoadConditionsCtx([{ id: "road-conditions-test", getEvents }]);
    expect(ctx.getDisallowedSourceIds).toBeUndefined();
    const result = await activeClosuresForBbox(ctx, TEST_BBOX);
    expect(result.points).toEqual([[0.5, 51.5]]);
  });

  it("handles MultiLineString geometry by densifying all lines into points", async () => {
    // Each line has vertices ~14 m apart (below the 45 m threshold), so no
    // intermediate points are inserted and the result covers both lines.
    const result = await run([
      closureAt({
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
      }),
    ]);
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
    const result = await run([
      closureAt({
        type: "MultiPoint",
        coordinates: [
          [12.0, 49.0],
          [12.2, 49.2],
        ],
      }),
    ]);
    expect(result.points).toEqual([
      [12.0, 49.0],
      [12.2, 49.2],
    ]);
    expect(result.polygons).toHaveLength(0);
  });

  it("handles GeometryCollection geometry by recursing into every member geometry", async () => {
    const result = await run([
      closureAt({
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
      }),
    ]);
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
    const result = await run([
      closureAt({ type: "MultiPolygon", coordinates: [[ring1], [ring2]] }),
    ]);
    expect(result.polygons).toHaveLength(2);
    expect(result.polygons[0]).toEqual(ring1);
    expect(result.polygons[1]).toEqual(ring2);
  });

  describe("one situation, several effects", () => {
    it("excludes the closing effect at its own location, not the situation's", async () => {
      const result = await run([
        closureAt(point(0.5, 51.5), {
          effects: [
            effect("test:1/speed", "speed_limit", { limit: { value: 60, unit: "km/h" } }),
            effect("test:1/ramp", "closure", {
              scope: "ramp",
              location: { geometry: { type: "Point", coordinates: [0.6, 51.6] } },
            }),
          ],
        }),
      ]);
      expect(result.points).toEqual([[0.6, 51.6]]);
    });

    it("excludes a shared situation geometry once for two closing effects", async () => {
      const result = await run([
        closureAt(point(0.5, 51.5), {
          effects: [
            effect("test:1/north", "closure", { scope: "carriageway" }),
            effect("test:1/south", "closure", { scope: "carriageway" }),
          ],
        }),
      ]);
      expect(result.points).toEqual([[0.5, 51.5]]);
    });

    it("does not exclude a closure of the cycleway beside the road", async () => {
      const result = await run([
        closureAt(point(0.5, 51.5), {
          effects: [effect("test:1/closure", "closure", { scope: "cycleway" })],
        }),
      ]);
      expect(result.points).toHaveLength(0);
    });
  });

  describe("origin-aware routing gate (crowd non-routing situations are dropped)", () => {
    const crowd = (evidence?: RoadConditionEvent["evidence"]) =>
      closureAt(point(0.5, 51.5), { origin: "crowd", evidence });

    it("drops a crowd closure that is not routingEligible", async () => {
      expect((await run([crowd({ state: "reported", routingEligible: false })])).points).toEqual(
        [],
      );
    });

    it("drops a crowd closure without any evidence", async () => {
      expect((await run([crowd()])).points).toEqual([]);
    });

    it("keeps a crowd closure once it is routingEligible", async () => {
      expect((await run([crowd({ state: "confirmed", routingEligible: true })])).points).toEqual([
        [0.5, 51.5],
      ]);
    });

    it("drops a federated closure that is not routingEligible", async () => {
      expect((await run([closureAt(point(0.5, 51.5), { origin: "federation" })])).points).toEqual(
        [],
      );
    });

    it("keeps a feed closure regardless of routingEligible", async () => {
      expect((await run([closureAt(point(0.5, 51.5), { origin: "feed" })])).points).toEqual([
        [0.5, 51.5],
      ]);
    });
  });

  describe("time-aware filtering (validity vs travel time)", () => {
    // Planned closure in effect 2026-07-10 22:00 → 2026-07-13 05:00 (CEST).
    const plannedClosure = closureAt(point(0.5, 51.5), {
      temporality: "scheduled",
      planned: true,
      validity: {
        status: "planned",
        start: "2026-07-10T22:00:00+02:00",
        end: "2026-07-13T05:00:00+02:00",
      },
    });

    it("skips a closure that has not started by the requested travel time", async () => {
      const result = await run([plannedClosure], new Date("2026-07-01T08:00:00Z"));
      expect(result.points).toHaveLength(0);
    });

    it("includes the closure when the travel time falls inside its window", async () => {
      const result = await run([plannedClosure], new Date("2026-07-11T08:00:00Z"));
      expect(result.points).toEqual([[0.5, 51.5]]);
    });

    it("skips a closure whose window already ended by the travel time", async () => {
      const result = await run([plannedClosure], new Date("2026-07-20T08:00:00Z"));
      expect(result.points).toHaveLength(0);
    });

    it("always includes an unbounded (ongoing, no start/end) closure", async () => {
      const result = await run([closureAt(point(0.5, 51.5))], new Date("2026-07-01T08:00:00Z"));
      expect(result.points).toEqual([[0.5, 51.5]]);
    });

    it.each(["ended", "cancelled"] as const)(
      "skips a closure whose source says %s",
      async (status) => {
        const result = await run([closureAt(point(0.5, 51.5), { validity: { status } })]);
        expect(result.points).toHaveLength(0);
      },
    );

    it("evaluates an effect against its own validity before its situation's", async () => {
      // Works run all month; the full closure is one weekend phase of them.
      const works = closureAt(point(0.5, 51.5), {
        validity: { status: "active", start: "2026-07-01T00:00:00Z", end: "2026-07-31T00:00:00Z" },
        effects: [
          effect("test:1/closure", "closure", {
            validity: {
              status: "planned",
              start: "2026-07-11T00:00:00Z",
              end: "2026-07-13T00:00:00Z",
            },
          }),
        ],
      });
      expect((await run([works], new Date("2026-07-05T12:00:00Z"))).points).toHaveLength(0);
      expect((await run([works], new Date("2026-07-12T12:00:00Z"))).points).toEqual([[0.5, 51.5]]);
    });
  });

  describe("recurring periods (nightly windows intersected with the outer span)", () => {
    // Nightly 20:00–05:00 Europe/Berlin (CEST +02:00 in summer) over 29 Jun–1 Jul.
    // Each occurrence = 20:00 local (18:00Z) for 9h → ends 03:00Z next day.
    const nightlyPeriod = {
      repeatFrequency: "P1D",
      startTime: "20:00",
      duration: "PT9H",
      scheduleTimezone: "Europe/Berlin",
    };
    const nightly = closureAt(point(0.5, 51.5), {
      validity: {
        status: "active",
        start: "2026-06-29T18:00:00.000Z",
        end: "2026-07-02T03:00:00.000Z",
        periods: [{ ...nightlyPeriod, startDate: "2026-06-29", endDate: "2026-07-01" }],
      },
    });
    const at = (iso: string) => run([nightly], new Date(iso));

    it("avoids the closure at night (inside a window)", async () => {
      // 23:00Z = 01:00 Berlin on Jul 1 — inside the Jun-30 night window.
      expect((await at("2026-06-30T23:00:00Z")).points).toEqual([[0.5, 51.5]]);
    });

    it("does NOT avoid it during the day, even within the outer start–end span", async () => {
      // 14:00Z = 16:00 Berlin — between windows.
      expect((await at("2026-06-30T14:00:00Z")).points).toHaveLength(0);
    });

    it("avoids the early-morning tail of an overnight window (attributed to the prior day)", async () => {
      // 02:00Z Jul 1 = 04:00 Berlin — still inside the Jun-30 night window (→03:00Z).
      expect((await at("2026-07-01T02:00:00Z")).points).toEqual([[0.5, 51.5]]);
    });

    it("does NOT avoid it on a night outside the window's date range", async () => {
      expect((await at("2026-07-15T23:00:00Z")).points).toHaveLength(0);
    });

    it("does NOT avoid it once the outer span has expired, even on a matching night", async () => {
      // The recurrence rule itself has no end date, so only the expired end
      // can rule this out — a period must never outlive its span.
      const openEnded = closureAt(point(0.5, 51.5), {
        validity: {
          status: "active",
          start: "2026-06-29T18:00:00.000Z",
          end: "2026-07-02T03:00:00.000Z",
          periods: [nightlyPeriod],
        },
      });
      // 23:00Z = 01:00 Berlin — a matching night window, but weeks after the end.
      const result = await run([openEnded], new Date("2026-08-20T23:00:00Z"));
      expect(result.points).toHaveLength(0);
    });

    it("does NOT avoid it before its start, even on a matching night", async () => {
      const future = closureAt(point(0.5, 51.5), {
        validity: {
          status: "planned",
          start: "2026-08-01T18:00:00.000Z",
          periods: [nightlyPeriod],
        },
      });
      const result = await run([future], new Date("2026-07-10T23:00:00Z"));
      expect(result.points).toHaveLength(0);
    });

    it("avoids it when both the outer span and a period contain the travel time", async () => {
      const future = closureAt(point(0.5, 51.5), {
        validity: {
          status: "planned",
          start: "2026-08-01T18:00:00.000Z",
          periods: [nightlyPeriod],
        },
      });
      const result = await run([future], new Date("2026-08-20T23:00:00Z"));
      expect(result.points).toEqual([[0.5, 51.5]]);
    });

    it("does NOT avoid it inside an exception window", async () => {
      const excepted = closureAt(point(0.5, 51.5), {
        validity: {
          status: "active",
          periods: [nightlyPeriod],
          exceptions: [
            { startDate: "2026-08-20", endDate: "2026-08-21", scheduleTimezone: "Europe/Berlin" },
          ],
        },
      });
      const result = await run([excepted], new Date("2026-08-20T23:00:00Z"));
      expect(result.points).toHaveLength(0);
    });
  });

  describe("graph-bound effects (never projected back onto raw geometry)", () => {
    const now = Date.now();
    const currentEvidence = {
      source_checked_at: new Date(now - 1_000).toISOString(),
      fresh_until: new Date(now + 60_000).toISOString(),
      expires_at: new Date(now + 120_000).toISOString(),
      valid_from: new Date(now - 60_000).toISOString(),
      valid_to: new Date(now + 120_000).toISOString(),
      evaluated_at: new Date(now - 1_000).toISOString(),
    };
    const bound = (evidence: Record<string, unknown> = {}) =>
      boundEvent({ id: "test:bound", geometry: point(0.5, 51.5) }, effect("test:bound/closure"), {
        ...currentEvidence,
        ...evidence,
      });
    const unbound = closureAt(point(0.7, 51.7), { id: "test:unbound" });

    it("does not point-fallback a bound closure and keeps one from a provider without evidence", async () => {
      const result = await run([bound(), unbound]);
      expect(result.points).toEqual([[0.7, 51.7]]);
    });

    it.each(["ambiguous", "unresolved", "no_coverage"] as const)(
      "does not point-fallback a closure whose binding is %s",
      async (status) => {
        const result = await run([bound({ binding_status: status })]);
        expect(result.points).toEqual([]);
        expect(result.polygons).toEqual([]);
        expect(result.roadConditionImpact.reasons).toContain("binding_not_routable");
      },
    );

    it("does not point-fallback an effect its provider left without evidence", async () => {
      const event = bound();
      event.effects.push(effect("test:bound/ramp", "closure", { scope: "ramp" }));
      const result = await run([event]);
      expect(result.points).toEqual([]);
      expect(result.roadConditionImpact.reasons).toContain("missing_routing_evidence");
    });

    it("reports the mode when graph routing evidence cannot serve it", async () => {
      const getEvents = vi.fn().mockResolvedValue([bound()]);
      const ctx = makeRoadConditionsCtx([{ id: "road-conditions-openconditions", getEvents }]);
      const result = await activeClosuresForBbox(ctx, TEST_BBOX, new Date(now), "cycling");
      expect(result.points).toEqual([]);
      expect(result.polygons).toEqual([]);
      expect(result.roadConditionImpact.availability).toBe("unsupported");
      expect(result.roadConditionImpact.reasons).toContain("unsupported_mode");
    });
  });

  describe("closure predicate shared with the edge-closure writer", () => {
    const withEffect = (fields: Record<string, unknown>) =>
      run([
        closureAt(point(0.5, 51.5), { effects: [effect("pred:1/closure", "closure", fields)] }),
      ]);

    it("does not exclude a closure scoped to lorries only", async () => {
      expect(
        (await withEffect({ applicability: { kind: "classes", include: [{ class: "truck" }] } }))
          .points,
      ).toHaveLength(0);
    });

    it("excludes a closure scoped to a passenger-car class", async () => {
      expect(
        (await withEffect({ applicability: { kind: "classes", include: [{ class: "car" }] } }))
          .points,
      ).toEqual([[0.5, 51.5]]);
    });

    it("does not exclude a closure that spares cars", async () => {
      expect(
        (await withEffect({ applicability: { kind: "all", except: [{ class: "car" }] } })).points,
      ).toHaveLength(0);
    });

    it("does not exclude a closure for vehicles the source did not name", async () => {
      expect((await withEffect({ applicability: { kind: "unknown" } })).points).toHaveLength(0);
    });

    it("does not exclude a closure the host could only partly read", async () => {
      expect((await withEffect({ normalization: "partial" })).points).toHaveLength(0);
    });
  });
});
