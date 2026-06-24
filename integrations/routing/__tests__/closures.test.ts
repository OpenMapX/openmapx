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

  it("caps total exclusion points below Valhalla's exclude-locations limit and warns", async () => {
    // A ~3.3 km LineString densifies to ~74 points (> the 45-point cap). Valhalla
    // rejects > 50 exclude_locations with HTTP 400, so the result must be trimmed.
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
    expect(result.points.length).toBeGreaterThan(1);
    expect(result.points.length).toBeLessThanOrEqual(45);
    // Subsampling keeps geographic spread, including the first vertex.
    expect(result.points[0]).toEqual([0.1, 51.1]);
    expect(ctx.log.warn).toHaveBeenCalled();
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

  it("calls getEvents with closure types and minSeverity high", async () => {
    const getEvents = vi.fn().mockResolvedValue([]);
    const ctx = makeRoadConditionsCtx([{ id: "road-conditions-test", getEvents }]);
    await activeClosuresForBbox(ctx, TEST_BBOX);
    expect(getEvents).toHaveBeenCalledWith(TEST_BBOX, {
      types: ["road_closure", "lane_closure"],
      minSeverity: "high",
    });
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
});
