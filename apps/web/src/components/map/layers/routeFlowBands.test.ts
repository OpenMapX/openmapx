import type { LngLat, RouteFlowSpan } from "@openmapx/core";
import { lineString } from "@turf/helpers";
import length from "@turf/length";
import lineSliceAlong from "@turf/line-slice-along";
import type * as maplibregl from "maplibre-gl";
import { describe, expect, it } from "vitest";
import {
  activeSpanFilter,
  type BandRoute,
  buildCurrentSpanFeatures,
  buildStaticSpanFeatures,
  clipSpans,
  MIN_DRAWN_METERS,
} from "./routeFlowBands";

const M = 0.001 / 111.32;
const ROUTE = Array.from({ length: 21 }, (_, i) => [8, 50 + 100 * i * M] as [number, number]);
const ROUTE_TOTAL_METERS = length(lineString(ROUTE), { units: "kilometers" }) * 1000;
const NAN_ROUTE: LngLat[] = [
  [8, 50],
  [Number.NaN, 50.01],
  [8, 50.02],
];

const span = (
  start: number,
  end: number,
  los: RouteFlowSpan["los"] = "queuing",
): RouteFlowSpan => ({
  startMeters: start,
  endMeters: end,
  los,
  confidence: "measured",
});

describe("clipSpans", () => {
  it("keeps every span when nothing has been driven", () => {
    expect(clipSpans([span(100, 400)], 0)).toEqual([span(100, 400)]);
  });

  it("drops a span entirely behind the driver", () => {
    expect(clipSpans([span(100, 400)], 600)).toEqual([]);
  });

  it("trims a span the driver is inside", () => {
    expect(clipSpans([span(100, 400)], 250)).toEqual([{ ...span(100, 400), startMeters: 250 }]);
  });

  it("drops a span the driver has all but left", () => {
    expect(clipSpans([span(100, 400)], 395)).toEqual([]);
  });
});

/**
 * A private copy of the pre-split `buildBandFeatures`, kept only here as the
 * oracle for the differential tests below. Production no longer exports this
 * combined form — it now ships `buildStaticSpanFeatures` +
 * `buildCurrentSpanFeatures` + `activeSpanFilter` instead, and this function
 * is what proves the split is exactly equivalent to what it replaced.
 */
interface OracleRoute {
  id: string;
  geometry: LngLat[];
  variant: "active" | "alt";
  alongMeters?: number;
}

function oracleBuildBandFeatures(
  routes: readonly OracleRoute[],
  spansByRoute: Record<string, RouteFlowSpan[]>,
): GeoJSON.Feature[] {
  const features: GeoJSON.Feature[] = [];
  for (const route of routes) {
    const spans = spansByRoute[route.id];
    if (!spans || spans.length === 0 || route.geometry.length < 2) continue;
    const line = lineString(route.geometry);
    const totalMeters = length(line, { units: "kilometers" }) * 1000;
    for (const s of clipSpans(spans, route.alongMeters ?? 0)) {
      const start = Math.max(0, Math.min(s.startMeters, totalMeters));
      const end = Math.max(0, Math.min(s.endMeters, totalMeters));
      if (end - start < MIN_DRAWN_METERS) continue;
      let sliced: GeoJSON.Feature<GeoJSON.LineString>;
      try {
        sliced = lineSliceAlong(line, start / 1000, end / 1000, { units: "kilometers" });
      } catch {
        continue;
      }
      features.push({
        type: "Feature",
        geometry: sliced.geometry,
        properties: {
          variant: route.variant,
          los: s.los,
          confidence: s.confidence,
          speedRatio: s.speedRatio ?? null,
        },
      });
    }
  }
  return features;
}

/**
 * Interprets exactly the two filter shapes {@link activeSpanFilter} can
 * produce — a real MapLibre expression evaluator would be overkill for two
 * known shapes, and would hide a shape drift instead of failing loudly on one.
 */
function passesFilter(
  filterSpec: maplibregl.FilterSpecification,
  feature: GeoJSON.Feature,
): boolean {
  const props = (feature.properties ?? {}) as Record<string, unknown>;
  const filter = filterSpec as unknown as unknown[];
  if (filter[0] === "==") {
    return props.variant === filter[2];
  }
  if (filter[0] === "all") {
    const [, eq, cmp] = filter as [string, unknown[], unknown[]];
    const variantOk = props.variant === (eq as unknown[])[2];
    const [, boundary] = cmp as [string, number, unknown[]];
    const startMeters = props.startMeters as number;
    return variantOk && boundary <= startMeters;
  }
  throw new Error(`unrecognised filter shape: ${JSON.stringify(filter)}`);
}

/** Coordinates + the properties both old and new code agree on, order-independent. */
function normalize(features: readonly GeoJSON.Feature[]): unknown[] {
  return features
    .map((f) => ({
      coordinates: (f.geometry as GeoJSON.LineString).coordinates,
      variant: f.properties?.variant,
      los: f.properties?.los,
      confidence: f.properties?.confidence,
      speedRatio: f.properties?.speedRatio ?? null,
    }))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

/**
 * The new split path's drawn output for one route at one progress value:
 * whatever of the static source survives `activeSpanFilter`, plus whatever
 * the current-span source holds. Alternates never receive `alongMeters` (the
 * production component never calls `buildCurrentSpanFeatures` for one, and
 * its filter is the plain `variant == "alt"`), so this only threads
 * `alongMeters` through for an "active" route — matching how
 * `RouteTrafficLayer` calls these functions.
 */
function actualDrawnFeatures(
  route: BandRoute,
  spans: readonly RouteFlowSpan[],
  alongMeters: number,
): GeoJSON.Feature[] {
  const isActive = route.variant === "active";
  const effectiveAlong = isActive ? alongMeters : 0;
  const staticFc = buildStaticSpanFeatures([route], { [route.id]: [...spans] });
  const filter = isActive
    ? activeSpanFilter(effectiveAlong)
    : (["==", ["get", "variant"], "alt"] as maplibregl.FilterSpecification);
  const staticDrawn = staticFc.features.filter((f) => passesFilter(filter, f));
  const current = isActive ? buildCurrentSpanFeatures(route, spans, effectiveAlong) : [];
  return [...staticDrawn, ...current];
}

function expectMatchesOracle(
  route: BandRoute,
  spans: readonly RouteFlowSpan[],
  alongMeters: number,
): void {
  const oracle = oracleBuildBandFeatures(
    [
      {
        id: route.id,
        geometry: route.geometry,
        variant: route.variant,
        ...(route.variant === "active" && alongMeters > 0 ? { alongMeters } : {}),
      },
    ],
    { [route.id]: [...spans] },
  );
  const actual = actualDrawnFeatures(route, spans, alongMeters);
  expect(normalize(actual)).toEqual(normalize(oracle));
}

describe("split static/current spans match the pre-split oracle", () => {
  const ACTIVE: BandRoute = { id: "r0", geometry: ROUTE, variant: "active" };
  const ALT: BandRoute = { id: "r1", geometry: ROUTE, variant: "alt" };

  it("progress before any span", () => {
    expectMatchesOracle(ACTIVE, [span(400, 800)], 0);
  });

  it("progress well before any span (still ahead, not zero)", () => {
    expectMatchesOracle(ACTIVE, [span(400, 800)], 100);
  });

  it("progress inside a span", () => {
    expectMatchesOracle(ACTIVE, [span(400, 800)], 600);
  });

  it("progress between two spans", () => {
    expectMatchesOracle(ACTIVE, [span(200, 400), span(900, 1200)], 600);
  });

  it("progress after all spans", () => {
    expectMatchesOracle(ACTIVE, [span(200, 400), span(500, 700)], 900);
  });

  it("progress exactly at a span boundary", () => {
    expectMatchesOracle(ACTIVE, [span(400, 800)], 400);
  });

  it("overlapping spans", () => {
    expectMatchesOracle(ACTIVE, [span(300, 700), span(500, 900)], 600);
  });

  it("a span shorter than MIN_DRAWN_METERS", () => {
    expectMatchesOracle(ACTIVE, [span(400, 400 + MIN_DRAWN_METERS - 1)], 0);
  });

  it("a span shorter than MIN_DRAWN_METERS once trimmed by progress", () => {
    // 800 - 780 = 20 < MIN_DRAWN_METERS once clipped to alongMeters.
    expectMatchesOracle(ACTIVE, [span(400, 800)], 780);
  });

  it("a span extending past the end of the route", () => {
    expectMatchesOracle(ACTIVE, [span(ROUTE_TOTAL_METERS - 200, ROUTE_TOTAL_METERS + 5000)], 0);
  });

  it("a span extending past the route end, progress inside it", () => {
    expectMatchesOracle(
      ACTIVE,
      [span(ROUTE_TOTAL_METERS - 200, ROUTE_TOTAL_METERS + 5000)],
      ROUTE_TOTAL_METERS - 100,
    );
  });

  it("a span with a negative startMeters", () => {
    expectMatchesOracle(ACTIVE, [span(-50, 400)], 0);
  });

  it("a span with a negative startMeters and alongMeters exactly 0", () => {
    // clipSpans's own `alongMeters <= 0` early return keeps the negative
    // startMeters untouched; buildCurrentSpanFeatures must contribute nothing.
    expectMatchesOracle(ACTIVE, [span(-50, 400)], 0);
    expect(buildCurrentSpanFeatures(ACTIVE, [span(-50, 400)], 0)).toEqual([]);
  });

  it("alongMeters exactly 0 with an ordinary span", () => {
    expectMatchesOracle(ACTIVE, [span(100, 400)], 0);
  });

  it("an alternate route never receives alongMeters", () => {
    expectMatchesOracle(ALT, [span(400, 800)], 600);
  });

  it("empty spans for the route", () => {
    expectMatchesOracle(ACTIVE, [], 300);
  });

  it("a route with a NaN coordinate degrades to nothing drawn, not a throw", () => {
    const route: BandRoute = { id: "r0", geometry: NAN_ROUTE, variant: "active" };
    expect(() => actualDrawnFeatures(route, [span(0, 100)], 0)).not.toThrow();
    expectMatchesOracle(route, [span(0, 100)], 0);
  });

  it("a stale alongMeters far past the route end", () => {
    expectMatchesOracle(ACTIVE, [span(1500, 2600)], ROUTE_TOTAL_METERS + 10_000);
  });
});

describe("buildStaticSpanFeatures", () => {
  it("carries the raw span offsets and route id for the filter to compare against", () => {
    const fc = buildStaticSpanFeatures([{ id: "r0", geometry: ROUTE, variant: "active" }], {
      r0: [span(400, 800)],
    });
    expect(fc.features[0].properties).toMatchObject({
      routeId: "r0",
      startMeters: 400,
      endMeters: 800,
      variant: "active",
      los: "queuing",
    });
  });

  it("skips routes with no spans and spans on unknown routes", () => {
    const fc = buildStaticSpanFeatures([{ id: "r0", geometry: ROUTE, variant: "active" }], {
      r0: [],
      r9: [span(100, 500)],
    });
    expect(fc.features).toEqual([]);
  });
});

describe("activeSpanFilter", () => {
  it("drops the startMeters comparison entirely at alongMeters <= 0", () => {
    expect(activeSpanFilter(0)).toEqual(["==", ["get", "variant"], "active"]);
    expect(activeSpanFilter(-5)).toEqual(["==", ["get", "variant"], "active"]);
  });

  it("compares startMeters against alongMeters once progress has started", () => {
    expect(activeSpanFilter(300)).toEqual([
      "all",
      ["==", ["get", "variant"], "active"],
      ["<=", 300, ["get", "startMeters"]],
    ]);
  });
});

describe("buildCurrentSpanFeatures", () => {
  it("returns nothing at alongMeters <= 0", () => {
    expect(
      buildCurrentSpanFeatures(
        { id: "r0", geometry: ROUTE, variant: "active" },
        [span(100, 400)],
        0,
      ),
    ).toEqual([]);
  });

  it("trims the span the driver is inside to start at alongMeters", () => {
    const [feature] = buildCurrentSpanFeatures(
      { id: "r0", geometry: ROUTE, variant: "active" },
      [span(400, 800)],
      600,
    );
    const coords = (feature.geometry as GeoJSON.LineString).coordinates;
    expect(coords[0][1]).toBeGreaterThan(50 + 550 * M);
    expect(coords[coords.length - 1][1]).toBeLessThan(50 + 850 * M);
  });

  it("returns every overlapping span the driver is inside, not just one", () => {
    const features = buildCurrentSpanFeatures(
      { id: "r0", geometry: ROUTE, variant: "active" },
      [span(300, 700), span(500, 900)],
      600,
    );
    expect(features).toHaveLength(2);
  });
});
