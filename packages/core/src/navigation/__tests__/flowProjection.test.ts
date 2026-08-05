import { describe, expect, it } from "vitest";
import type { LngLat } from "../../types/geometry";
import type { RoadFlowSegment, RouteFlowSpan } from "../../types/roadConditions";
import { haversineDistance } from "../../utils/coordinates";
import { angularDifference, bearingBetween, routeBearingAt } from "../bearing";
import {
  type FlowOverlapCounters,
  flowSeverityRank,
  type ProjectFlowOptions,
  projectFlowToRoute,
  type RankedFlowSpan,
  resolveFlowOverlaps,
  routeFingerprint,
} from "../flowProjection";
import {
  readRouteMatcherCounters,
  resetRouteMatcherCounters,
  setRouteMatcherCounting,
} from "../routeMatcher";
import { snapToRoute } from "../snap";

/** ~111 m per 0.001° of latitude — used to build fixtures with round distances. */
const M = 0.001 / 111.32;

/** A due-north route from [8, 50] of `meters` length. */
function northRoute(meters: number, steps = 20): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i <= steps; i++) out.push([8, 50 + (meters / steps) * i * M]);
  return out;
}

/** Local flat-earth (east, north) metres -> [lng, lat], anchored near [8, 50]. */
function localToLngLat(eastMeters: number, northMeters: number): [number, number] {
  const metersPerDegLat = 111_320;
  const metersPerDegLng = 111_320 * Math.cos((50 * Math.PI) / 180);
  return [8 + eastMeters / metersPerDegLng, 50 + northMeters / metersPerDegLat];
}

/** A finely sampled arc of a circle of `radiusM`, sweeping `totalAngleDeg`
 * clockwise from north — used to build a smoothly curving route. */
function arcRoute(radiusM: number, totalAngleDeg: number, steps = 400): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i <= steps; i++) {
    const angle = ((totalAngleDeg * Math.PI) / 180) * (i / steps);
    out.push(localToLngLat(radiusM * Math.sin(angle), radiusM * (1 - Math.cos(angle))));
  }
  return out;
}

/** A point on that same circle at `angleDeg`. */
function arcPoint(radiusM: number, angleDeg: number): [number, number] {
  const angle = (angleDeg * Math.PI) / 180;
  return localToLngLat(radiusM * Math.sin(angle), radiusM * (1 - Math.cos(angle)));
}

/**
 * A switchback: a straight 100 m approach heading east into a full 180° U-turn
 * of `radiusM`, then a straight 100 m exit continuing west — tangents match
 * smoothly at both joins, so the whole thing is one legitimately contiguous
 * road, not two roads glued together.
 */
function hairpinRoute(radiusM: number): [number, number][] {
  return [localToLngLat(-100, 0), ...arcRoute(radiusM, 180), localToLngLat(-100, 2 * radiusM)];
}

/**
 * A route that runs north, detours 150 m east and 100 m north and back, then
 * continues north — a rectangular loop-out, like a service road or ramp,
 * whose two ends are close together (120 m apart) despite the ~420 m of
 * route between them.
 */
function detourRoute(): [number, number][] {
  return [
    [0, -50],
    [0, 0],
    [150, 0],
    [150, 100],
    [0, 100],
    [0, 150],
  ].map(([x, y]) => localToLngLat(x, y));
}

function segment(
  coords: [number, number][],
  overrides: Partial<RoadFlowSegment> = {},
): RoadFlowSegment {
  return {
    id: overrides.id ?? "seg",
    geometry: { type: "LineString", coordinates: coords },
    los: overrides.los ?? "queuing",
    confidence: overrides.confidence ?? "measured",
    direction: overrides.direction ?? "f",
    ...overrides,
  } as RoadFlowSegment;
}

describe("projectFlowToRoute", () => {
  it("projects an on-route segment to its along-route offsets", () => {
    const route = northRoute(2000);
    const spans = projectFlowToRoute(
      [
        segment([
          [8, 50 + 500 * M],
          [8, 50 + 1000 * M],
        ]),
      ],
      route,
    );
    expect(spans).toHaveLength(1);
    expect(spans[0].startMeters).toBeGreaterThan(450);
    expect(spans[0].startMeters).toBeLessThan(550);
    expect(spans[0].endMeters).toBeGreaterThan(950);
    expect(spans[0].endMeters).toBeLessThan(1050);
    expect(spans[0].los).toBe("queuing");
  });

  it("rejects a parallel road outside the corridor", () => {
    const route = northRoute(2000);
    const parallel = segment([
      [8.002, 50 + 500 * M],
      [8.002, 50 + 1000 * M],
    ]);
    expect(projectFlowToRoute([parallel], route)).toEqual([]);
  });

  it("rejects the opposite carriageway by bearing", () => {
    const route = northRoute(2000);
    const southbound = segment(
      [
        [8, 50 + 1000 * M],
        [8, 50 + 500 * M],
      ],
      { direction: "b" },
    );
    expect(projectFlowToRoute([southbound], route)).toEqual([]);
  });

  it("drops a span shorter than the minimum", () => {
    const route = northRoute(2000);
    const stub = segment([
      [8, 50 + 500 * M],
      [8, 50 + 520 * M],
    ]);
    expect(projectFlowToRoute([stub], route)).toEqual([]);
  });

  it("merges two same-level spans separated by a small gap", () => {
    const route = northRoute(2000);
    const spans = projectFlowToRoute(
      [
        segment(
          [
            [8, 50 + 400 * M],
            [8, 50 + 600 * M],
          ],
          { id: "a" },
        ),
        segment(
          [
            [8, 50 + 640 * M],
            [8, 50 + 900 * M],
          ],
          { id: "b" },
        ),
      ],
      route,
    );
    expect(spans).toHaveLength(1);
    expect(spans[0].endMeters).toBeGreaterThan(850);
  });

  it("lets the worse level win where two spans overlap", () => {
    const route = northRoute(2000);
    // The standstill is listed first on purpose: with the worse segment last,
    // a naive last-one-wins overlap resolution would pass this test without
    // ever ranking the two.
    const spans = projectFlowToRoute(
      [
        segment(
          [
            [8, 50 + 600 * M],
            [8, 50 + 700 * M],
          ],
          { id: "b", los: "stationary" },
        ),
        segment(
          [
            [8, 50 + 400 * M],
            [8, 50 + 900 * M],
          ],
          { id: "a", los: "heavy" },
        ),
      ],
      route,
    );
    const worst = spans.find((s) => s.los === "stationary");
    expect(worst).toBeDefined();
    if (!worst) throw new Error("expected a stationary span");
    expect(worst.startMeters).toBeGreaterThan(550);
    expect(worst.endMeters).toBeLessThan(750);
    expect(spans.filter((s) => s.los === "heavy")).toHaveLength(2);
  });

  it("returns nothing for a route with fewer than two points", () => {
    expect(
      projectFlowToRoute(
        [
          segment([
            [8, 50],
            [8, 50.01],
          ]),
        ],
        [[8, 50]],
      ),
    ).toEqual([]);
  });

  it("splits into separate spans when a segment leaves the corridor and rejoins", () => {
    const route = northRoute(2000);
    // Follows the route, swings ~140 m off it (well past the 25 m corridor),
    // then rejoins further along — a slip road or loop doubling back.
    const wanderer = segment([
      [8, 50 + 400 * M],
      [8, 50 + 500 * M],
      [8.002, 50 + 550 * M],
      [8.002, 50 + 650 * M],
      [8, 50 + 700 * M],
      [8, 50 + 800 * M],
    ]);
    const spans = projectFlowToRoute([wanderer], route);
    expect(spans).toHaveLength(2);
    expect(spans[0].startMeters).toBeGreaterThan(350);
    expect(spans[0].endMeters).toBeLessThan(550);
    expect(spans[1].startMeters).toBeGreaterThan(650);
    expect(spans[1].endMeters).toBeLessThan(850);
    // The diverged middle must not be claimed by either span.
    expect(spans.some((s) => s.startMeters <= 600 && s.endMeters >= 600)).toBe(false);
  });

  it("returns a free-flow span rather than filtering it out", () => {
    const route = northRoute(2000);
    const spans = projectFlowToRoute(
      [
        segment(
          [
            [8, 50 + 300 * M],
            [8, 50 + 600 * M],
          ],
          { los: "free_flow", speedRatio: 1 },
        ),
      ],
      route,
    );
    expect(spans).toHaveLength(1);
    expect(spans[0].los).toBe("free_flow");
  });

  it("lets a free-flow observation lose to an overlapping jam but survive outside it", () => {
    const route = northRoute(2000);
    const spans = projectFlowToRoute(
      [
        segment(
          [
            [8, 50 + 300 * M],
            [8, 50 + 900 * M],
          ],
          { id: "clear", los: "free_flow", speedRatio: 1 },
        ),
        segment(
          [
            [8, 50 + 500 * M],
            [8, 50 + 700 * M],
          ],
          { id: "jam", los: "stationary" },
        ),
      ],
      route,
    );
    const jam = spans.find((s) => s.los === "stationary");
    expect(jam).toBeDefined();
    if (!jam) throw new Error("expected a stationary span");
    expect(jam.startMeters).toBeGreaterThan(450);
    expect(jam.endMeters).toBeLessThan(750);
    const freeFlowSpans = spans.filter((s) => s.los === "free_flow");
    expect(freeFlowSpans.some((s) => s.endMeters <= 550)).toBe(true);
    expect(freeFlowSpans.some((s) => s.startMeters >= 650)).toBe(true);
  });

  it("does not split a segment that legitimately follows a curving route", () => {
    // radius 2000 m, sampled 15deg-85deg: chord ~2294 m, route arc ~2443 m —
    // a ~150 m arc/chord gap from curvature alone, on a route wide enough
    // that the forward guard's fixed corridor-only slack (50 m) would have
    // misfired here; the step-proportional slack must not.
    const radius = 2000;
    const route = arcRoute(radius, 100);
    const curved = segment([arcPoint(radius, 15), arcPoint(radius, 85)], { los: "heavy" });
    const spans = projectFlowToRoute([curved], route);
    expect(spans).toHaveLength(1);
  });

  it("keeps a hairpin as one span instead of splitting it where the route turns ~180°", () => {
    // A switchback: 100 m straight approach, a full 180° U-turn (radius
    // 1000 m), 100 m straight exit. The flow segment follows the route
    // exactly at all four vertices but — like real feed data — skips the
    // curve's interior, jumping straight from the turn's start to its end:
    // chord = 2r = 2000 m, route arc = π*r ≈ 3141.6 m, so
    // routeStep/segStep ≈ π/2 ≈ 1.5708 for that one jump — the semicircle
    // bound from RUN_STEP_SLACK_FACTOR's derivation. A factor of 1.5 fails
    // to clear it (1.5708 > 1.5) and breaks the run right there, producing
    // two ~100 m spans (the approach and exit legs) with the entire curve
    // as an uncovered hole between them; 2 clears it with margin and keeps
    // the whole ~3341.6 m stretch as one span.
    //
    // The two straight legs exist only so a wrongly broken run still leaves
    // two real (>= the 40 m minimum) spans to assert against, rather than
    // two single-point runs that both drop out as zero-length. A 180° turn
    // also needs a wider-than-default bearing tolerance: at each end of a
    // circular bend the local route tangent is off the chord connecting the
    // turn's two ends by half the swept angle (90° here, from the
    // tangent-chord angle theorem) — well over the default 45°, but nothing
    // to do with the forward guard under test.
    const radius = 1000;
    const route = hairpinRoute(radius);
    const turnStart = localToLngLat(0, 0);
    const turnEnd = localToLngLat(0, 2 * radius);
    const hairpin = segment(
      [localToLngLat(-100, 0), turnStart, turnEnd, localToLngLat(-100, 2 * radius)],
      { los: "heavy" },
    );
    const spans = projectFlowToRoute([hairpin], route, { directionToleranceDegrees: 100 });
    expect(spans).toHaveLength(1);
  });

  it("matches the pass of a doubling-back route the segment actually sits on", () => {
    // Northbound for 2 km, a wide excursion east, then southbound ~21 m to the
    // east of the outbound leg — close enough that both carriageways fall
    // inside the corridor box built around the segment, while everything
    // between them lies far outside it. The two are 2 km apart along the route
    // despite being metres apart on the ground, so a matcher that stitched the
    // two nearby stretches together would put the jam at an along-route
    // distance the driver never reaches at that point.
    const east = 0.0003;
    const route: [number, number][] = [];
    for (let i = 0; i <= 20; i++) route.push([8, 50 + 100 * i * M]);
    for (let i = 1; i <= 10; i++) route.push([8 + 0.002 * i, 50 + 2000 * M]);
    for (let i = 10; i >= 1; i--) route.push([8 + east + 0.002 * i, 50 + 2000 * M]);
    for (let i = 20; i >= 0; i--) route.push([8 + east, 50 + 100 * i * M]);

    const spans = projectFlowToRoute(
      [
        segment([
          [8, 50 + 500 * M],
          [8, 50 + 1000 * M],
          [8, 50 + 1500 * M],
        ]),
      ],
      route,
    );
    expect(spans).toHaveLength(1);
    expect(spans[0].startMeters).toBeGreaterThan(450);
    expect(spans[0].endMeters).toBeLessThan(1550);
  });

  it("stays fast on a long route with a busy corridor", () => {
    // Matching used to rescan the whole polyline once per sample, which is
    // quadratic in the route: this shape took ~50 s of uninterruptible work on
    // the API's shared event loop, and the endpoint accepts routes four times
    // this size. It now runs in a fraction of a second. The bound is a
    // tripwire for that scan coming back — generous enough for a loaded CI
    // machine, orders of magnitude under the unindexed cost.
    const points = 5000;
    const meters = 500_000;
    const route: [number, number][] = Array.from(
      { length: points },
      (_, i) => [8, 50 + meters * (i / (points - 1)) * M] as [number, number],
    );
    const segments = Array.from({ length: 150 }, (_, s) =>
      segment(
        Array.from({ length: 30 }, (_, i) => {
          const start = (meters * s) / 150;
          return [8, 50 + (start + (i * meters) / 150 / 60) * M] as [number, number];
        }),
        { id: `s${s}` },
      ),
    );

    const started = performance.now();
    const spans = projectFlowToRoute(segments, route);
    const elapsed = performance.now() - started;
    expect(spans.length).toBeGreaterThan(100);
    expect(elapsed).toBeLessThan(2500);
  });

  it("does not let a straight chord across a route detour claim the whole loop", () => {
    // The segment's two points sit 120 m apart in a straight line, but the
    // route between where they snap loops out and back for ~420 m (a service
    // road or ramp). One continuous span would wrongly paint the entire
    // loop; the guard must prevent that.
    const route = detourRoute();
    const [aLng, aLat] = localToLngLat(0, -10);
    const [bLng, bLat] = localToLngLat(0, 110);
    const cutter = segment([
      [aLng, aLat],
      [bLng, bLat],
    ]);
    const spans = projectFlowToRoute([cutter], route);
    // Without the guard this comes back as one ~420 m span (the whole loop);
    // with it, each end is an isolated zero-length touch that drops out
    // below the minimum span, so nothing anywhere near that wide survives.
    expect(spans.every((s) => s.endMeters - s.startMeters < 200)).toBe(true);
  });
});

describe("routeFingerprint", () => {
  // Pinned rather than just "changes when the input changes": the server
  // (flow cache key) and the client (query key) both call this function, so a
  // future edit that changes its output would silently invalidate every
  // cached entry and reroute-detection key on both sides at once. A pinned
  // value turns that into a loud, obvious test failure instead.
  it("is stable for a fixed geometry", () => {
    expect(
      routeFingerprint([
        [8, 50],
        [8.001, 50.001],
        [8.002, 50.0005],
      ]),
    ).toBe("3:96ey87");
  });

  it("changes when any point changes, not just the endpoints", () => {
    const base = routeFingerprint([
      [8, 50],
      [8.001, 50.001],
      [8.002, 50.0005],
    ]);
    const movedMidpoint = routeFingerprint([
      [8, 50],
      [8.001, 50.002],
      [8.002, 50.0005],
    ]);
    expect(movedMidpoint).not.toBe(base);
  });

  it("is a pure function of the geometry — same input, same output", () => {
    const geometry: [number, number][] = [
      [8, 50],
      [8.01, 50.01],
    ];
    expect(routeFingerprint(geometry)).toBe(routeFingerprint([...geometry]));
  });
});

/** Deterministic PRNG, so every randomized case below is reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function unitVector(p: LngLat): [number, number, number] {
  const lat = (p[1] * Math.PI) / 180;
  const lng = (p[0] * Math.PI) / 180;
  return [Math.cos(lat) * Math.cos(lng), Math.cos(lat) * Math.sin(lng), Math.sin(lat)];
}

function vectorToLngLat(v: [number, number, number]): LngLat {
  return [
    (Math.atan2(v[1], v[0]) * 180) / Math.PI,
    (Math.asin(Math.max(-1, Math.min(1, v[2]))) * 180) / Math.PI,
  ];
}

/**
 * The point at fraction `t` of the great circle from `a` to `b` — the path the
 * route actually takes between two vertices, which for an east-west pair at
 * high latitude runs well poleward of the latitude they share.
 */
function greatCirclePoint(a: LngLat, b: LngLat, t: number): LngLat {
  const va = unitVector(a);
  const vb = unitVector(b);
  const dot = Math.max(-1, Math.min(1, va[0] * vb[0] + va[1] * vb[1] + va[2] * vb[2]));
  const omega = Math.acos(dot);
  if (omega === 0) return [a[0], a[1]];
  const k1 = Math.sin((1 - t) * omega) / Math.sin(omega);
  const k2 = Math.sin(t * omega) / Math.sin(omega);
  return vectorToLngLat([
    k1 * va[0] + k2 * vb[0],
    k1 * va[1] + k2 * vb[1],
    k1 * va[2] + k2 * vb[2],
  ]);
}

/** The projection's own sampling and run constants, mirrored for the oracle. */
const ORACLE_MAX_SEGMENT_SAMPLES = 24;
const ORACLE_RUN_STEP_SLACK_FACTOR = 2;
const ORACLE_DEFAULTS = { corridor: 25, tolerance: 45, minSpan: 40, mergeGap: 60 };

function oracleSampleIndices(count: number): number[] {
  if (count <= ORACLE_MAX_SEGMENT_SAMPLES) return Array.from({ length: count }, (_, i) => i);
  const step = (count - 1) / (ORACLE_MAX_SEGMENT_SAMPLES - 1);
  return Array.from({ length: ORACLE_MAX_SEGMENT_SAMPLES }, (_, i) => Math.round(i * step));
}

function oracleSegmentSpans(
  seg: RoadFlowSegment,
  route: LngLat[],
  corridor: number,
  tolerance: number,
): RankedFlowSpan[] {
  const coords = seg.geometry.coordinates as LngLat[];
  if (coords.length < 2) return [];
  const rank = flowSeverityRank(seg.los, seg.speedRatio);
  const spans: RankedFlowSpan[] = [];
  let run: Array<{ alongMeters: number; point: LngLat }> = [];

  const closeRun = (): void => {
    if (run.length === 0) return;
    const alongs = run.map((s) => s.alongMeters);
    spans.push({
      startMeters: Math.min(...alongs),
      endMeters: Math.max(...alongs),
      los: seg.los,
      confidence: seg.confidence,
      rank,
      ...(seg.speedRatio !== undefined && { speedRatio: seg.speedRatio }),
      ...(seg.currentSpeedKph !== undefined && { currentSpeedKph: seg.currentSpeedKph }),
      ...(seg.freeFlowSpeedKph !== undefined && { freeFlowSpeedKph: seg.freeFlowSpeedKph }),
    });
    run = [];
  };

  for (const sample of oracleSampleIndices(coords.length)) {
    const here = coords[sample];
    const snap = snapToRoute(route, here);
    if (snap.deviationMeters > corridor) {
      closeRun();
      continue;
    }
    const ahead = coords[Math.min(sample + 1, coords.length - 1)];
    const behind = coords[Math.max(sample - 1, 0)];
    if (
      angularDifference(bearingBetween(behind, ahead), routeBearingAt(route, snap.segmentIndex)) >
      tolerance
    ) {
      closeRun();
      continue;
    }
    const previous = run[run.length - 1];
    if (previous) {
      const routeStep = snap.alongMeters - previous.alongMeters;
      const segStep = haversineDistance(previous.point, here);
      if (
        routeStep < -corridor ||
        routeStep > segStep * ORACLE_RUN_STEP_SLACK_FACTOR + corridor * 2
      ) {
        closeRun();
      }
    }
    run.push({ alongMeters: snap.alongMeters, point: here });
  }
  closeRun();
  return spans;
}

function oracleSameCondition(a: RankedFlowSpan, b: RankedFlowSpan): boolean {
  if (a.los !== b.los) return false;
  return Math.abs((a.speedRatio ?? -1) - (b.speedRatio ?? -1)) < 0.05;
}

/** The overlap resolver as it was: one all-pairs scan per boundary interval. */
function legacyResolveOverlaps(
  raw: readonly RankedFlowSpan[],
  minSpan: number,
  mergeGap: number,
): RouteFlowSpan[] {
  if (raw.length === 0) return [];
  const bounds = [...new Set(raw.flatMap((s) => [s.startMeters, s.endMeters]))].sort(
    (a, b) => a - b,
  );
  const intervals: RankedFlowSpan[] = [];
  for (let i = 1; i < bounds.length; i++) {
    const start = bounds[i - 1];
    const end = bounds[i];
    if (end - start <= 0) continue;
    const mid = (start + end) / 2;
    let winner: RankedFlowSpan | null = null;
    for (const span of raw) {
      if (span.startMeters > mid || span.endMeters < mid) continue;
      if (!winner || span.rank > winner.rank) winner = span;
    }
    if (winner) intervals.push({ ...winner, startMeters: start, endMeters: end });
  }

  const merged: RankedFlowSpan[] = [];
  for (const interval of intervals) {
    const previous = merged[merged.length - 1];
    if (
      previous &&
      oracleSameCondition(previous, interval) &&
      interval.startMeters - previous.endMeters <= mergeGap
    ) {
      previous.endMeters = interval.endMeters;
      continue;
    }
    merged.push({ ...interval });
  }

  return merged
    .filter((span) => span.endMeters - span.startMeters >= minSpan)
    .map(({ rank: _rank, ...span }) => span);
}

function oracleProject(
  segments: readonly RoadFlowSegment[],
  route: LngLat[],
  opts: ProjectFlowOptions = {},
): RouteFlowSpan[] {
  if (route.length < 2) return [];
  const corridor = opts.corridorMeters ?? ORACLE_DEFAULTS.corridor;
  const tolerance = opts.directionToleranceDegrees ?? ORACLE_DEFAULTS.tolerance;
  const minSpan = opts.minSpanMeters ?? ORACLE_DEFAULTS.minSpan;
  const mergeGap = opts.mergeGapMeters ?? ORACLE_DEFAULTS.mergeGap;
  const raw: RankedFlowSpan[] = [];
  for (const seg of segments) {
    for (const span of oracleSegmentSpans(seg, route, corridor, tolerance)) {
      if (span.endMeters - span.startMeters >= minSpan) raw.push(span);
    }
  }
  return legacyResolveOverlaps(raw, minSpan, mergeGap);
}

/** A route bowing north of latitude 80 between two points that share it. */
const POLAR_BOW_ROUTE: LngLat[] = [
  [-1, 80],
  [1, 80],
];

/** Samples straddling the top of that bow, all sitting on the route itself. */
function polarBowSegment(): RoadFlowSegment {
  const coords = Array.from({ length: 7 }, (_, i) =>
    greatCirclePoint(POLAR_BOW_ROUTE[0], POLAR_BOW_ROUTE[1], 0.4 + i * 0.03),
  );
  return segment(coords, { id: "bow", los: "queuing" });
}

interface Fixture {
  name: string;
  route: LngLat[];
  segments: RoadFlowSegment[];
  opts?: ProjectFlowOptions;
}

/** A wandering city street, ~1.4 km of short blocks with turns. */
function cityRoute(): LngLat[] {
  const rand = mulberry32(0xc17e);
  const out: LngLat[] = [];
  let east = 0;
  let north = 0;
  for (let i = 0; i < 60; i++) {
    east += 20 + rand() * 10;
    north += Math.sin(i / 6) * 15;
    out.push(localToLngLat(east, north));
  }
  return out;
}

const FIXTURES: Fixture[] = [
  {
    name: "a route bowing poleward of its endpoint latitudes",
    route: POLAR_BOW_ROUTE,
    segments: [polarBowSegment()],
  },
  {
    name: "a route crossing the antimeridian",
    route: Array.from(
      { length: 40 },
      (_, i) => [179.5 + i * 0.05 > 180 ? 179.5 + i * 0.05 - 360 : 179.5 + i * 0.05, 12] as LngLat,
    ),
    segments: [
      segment(
        Array.from(
          { length: 12 },
          (_, i) =>
            [179.8 + i * 0.05 > 180 ? 179.8 + i * 0.05 - 360 : 179.8 + i * 0.05, 12] as LngLat,
        ),
        { id: "dateline", los: "heavy" },
      ),
    ],
  },
  {
    name: "a near-polar route",
    route: Array.from({ length: 30 }, (_, i) => [i * 3, 89.5] as LngLat),
    segments: [
      segment(
        Array.from({ length: 10 }, (_, i) => [20 + i * 3, 89.5] as LngLat),
        { id: "polar", los: "stationary" },
      ),
    ],
    opts: { directionToleranceDegrees: 90 },
  },
  {
    name: "a route with edges hundreds of kilometres long",
    route: [
      [8, 50],
      [9, 51],
      [10, 52],
      [11, 53],
    ],
    segments: [
      segment(
        Array.from({ length: 9 }, (_, i) => greatCirclePoint([9, 51], [10, 52], i / 8)),
        { id: "long", los: "heavy" },
      ),
    ],
  },
  {
    name: "a route with duplicated vertices",
    route: [
      [8, 50],
      [8, 50],
      [8, 50 + 500 * M],
      [8, 50 + 500 * M],
      [8, 50 + 1000 * M],
      [8, 50 + 1000 * M],
      [8, 50 + 1500 * M],
    ],
    segments: [
      segment(
        [
          [8, 50 + 300 * M],
          [8, 50 + 700 * M],
          [8, 50 + 1100 * M],
        ],
        { id: "dupes", los: "queuing" },
      ),
    ],
  },
  {
    name: "two parallel passes of the same corridor",
    route: [
      ...Array.from({ length: 21 }, (_, i) => [8, 50 + 100 * i * M] as LngLat),
      ...Array.from({ length: 10 }, (_, i) => [8 + 0.002 * (i + 1), 50 + 2000 * M] as LngLat),
      ...Array.from({ length: 10 }, (_, i) => [8.0003 + 0.002 * (10 - i), 50 + 2000 * M] as LngLat),
      ...Array.from({ length: 21 }, (_, i) => [8.0003, 50 + 100 * (20 - i) * M] as LngLat),
    ],
    segments: [
      segment(
        [
          [8, 50 + 500 * M],
          [8, 50 + 1000 * M],
          [8, 50 + 1500 * M],
        ],
        { id: "pass", los: "heavy" },
      ),
    ],
  },
  {
    name: "an ordinary city street with three observations",
    route: cityRoute(),
    segments: [
      segment(cityRoute().slice(5, 20), { id: "a", los: "heavy", speedRatio: 0.6 }),
      segment(cityRoute().slice(15, 35), { id: "b", los: "queuing", speedRatio: 0.4 }),
      segment(cityRoute().slice(30, 50), { id: "c", los: "free_flow", speedRatio: 1 }),
    ],
  },
  {
    name: "an ordinary highway with a jam inside a heavy stretch",
    route: northRoute(20_000, 400),
    segments: [
      segment(
        Array.from({ length: 30 }, (_, i) => [8, 50 + (4000 + i * 200) * M] as LngLat),
        { id: "heavy", los: "heavy", speedRatio: 0.6 },
      ),
      segment(
        Array.from({ length: 10 }, (_, i) => [8, 50 + (6000 + i * 100) * M] as LngLat),
        { id: "jam", los: "stationary", speedRatio: 0.1 },
      ),
    ],
  },
];

describe("projectFlowToRoute against direct Turf snapping", () => {
  for (const fixture of FIXTURES) {
    it(`matches the oracle on ${fixture.name}`, () => {
      const expected = oracleProject(fixture.segments, fixture.route, fixture.opts);
      // Every fixture must have something to compare, or the differential is
      // two empty arrays agreeing with each other.
      expect(expected.length, "fixture produced no spans").toBeGreaterThan(0);
      expect(projectFlowToRoute(fixture.segments, fixture.route, fixture.opts)).toEqual(expected);
    });
  }

  it("returns the flow on a route that bows poleward of its endpoint latitudes", () => {
    // The great circle between two points sharing latitude 80 runs about 165 m
    // north of that latitude at its midpoint, so a segment sitting exactly on
    // the route falls outside any box drawn around the route's endpoints. Turf
    // puts these samples within a nanometre of the carriageway, so the flow
    // must be projected, not dropped — before this was fixed, no span came back
    // at all.
    const seg = polarBowSegment();
    for (const point of seg.geometry.coordinates as LngLat[]) {
      expect(snapToRoute(POLAR_BOW_ROUTE, point).deviationMeters).toBeLessThan(1);
    }
    const spans = projectFlowToRoute([seg], POLAR_BOW_ROUTE);
    expect(spans).toHaveLength(1);
    expect(spans[0].los).toBe("queuing");
    expect(spans[0].endMeters - spans[0].startMeters).toBeGreaterThan(6000);
  });

  it("matches the oracle on seeded random routes and observations", () => {
    const rand = mulberry32(0xf10a);
    let cases = 0;
    for (let iteration = 0; iteration < 60; iteration++) {
      const route: LngLat[] = [];
      let east = 0;
      let north = 0;
      for (let i = 0; i < 80; i++) {
        east += 30 + rand() * 60;
        north += (rand() - 0.5) * 40;
        route.push(localToLngLat(east, north));
      }
      const segments: RoadFlowSegment[] = [];
      for (let s = 0; s < 3; s++) {
        const from = Math.floor(rand() * 60);
        const length = 5 + Math.floor(rand() * 15);
        const drift = (rand() - 0.5) * 40;
        const los = (["free_flow", "heavy", "queuing", "stationary"] as const)[
          Math.floor(rand() * 4)
        ];
        segments.push(
          segment(
            route.slice(from, from + length).map(([lng, lat]) => [lng, lat + drift * M] as LngLat),
            { id: `r${s}`, los, speedRatio: Math.round(rand() * 100) / 100 },
          ),
        );
      }
      expect(projectFlowToRoute(segments, route)).toEqual(oracleProject(segments, route));
      cases++;
    }
    expect(cases).toBe(60);
  });
});

const RANDOM_LOS = ["free_flow", "unknown", "heavy", "queuing", "stationary"] as const;

function randomRawSpan(
  rand: () => number,
  start: number,
  end: number,
  ordinal: number,
): RankedFlowSpan {
  const los = RANDOM_LOS[Math.floor(rand() * RANDOM_LOS.length)];
  const speedRatio = rand() < 0.3 ? undefined : Math.round(rand() * 20) / 20;
  return {
    startMeters: start,
    endMeters: end,
    los,
    confidence: (["measured", "estimated", "typical", "unknown"] as const)[Math.floor(rand() * 4)],
    rank: flowSeverityRank(los, speedRatio),
    ...(speedRatio !== undefined && { speedRatio }),
    ...(ordinal % 3 === 0 && { currentSpeedKph: 10 + ordinal }),
  };
}

/** Raw span sets shaped like the arrangements the resolver has to survive. */
function rawSpanSet(shape: string, rand: () => number, count: number): RankedFlowSpan[] {
  const spans: RankedFlowSpan[] = [];
  for (let i = 0; i < count; i++) {
    let start: number;
    let end: number;
    switch (shape) {
      case "disjoint":
        start = i * 300;
        end = start + 100 + Math.floor(rand() * 100);
        break;
      case "nested":
        start = i * 50;
        end = count * 100 - i * 50;
        break;
      case "crossing":
        start = i * 40;
        end = start + 300 + Math.floor(rand() * 400);
        break;
      case "identical":
        // Every span starts and ends on one of four shared coordinates.
        start = [0, 100, 200, 300][Math.floor(rand() * 4)];
        end = start + [0, 100, 200, 300][Math.floor(rand() * 4)];
        break;
      case "zeroLength":
        start = Math.floor(rand() * 500);
        end = rand() < 0.5 ? start : start + Math.floor(rand() * 200);
        break;
      default:
        start = Math.floor(rand() * 1000);
        end = start + Math.floor(rand() * 300);
    }
    spans.push(randomRawSpan(rand, start, end, i));
  }
  return spans;
}

function shuffled<T>(items: readonly T[], rand: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

describe("resolveFlowOverlaps against the previous all-pairs resolver", () => {
  it("reproduces it exactly across seeded random span arrangements", () => {
    const shapes = ["disjoint", "nested", "crossing", "identical", "zeroLength", "mixed"];
    let cases = 0;
    for (const shape of shapes) {
      for (let iteration = 0; iteration < 40; iteration++) {
        const rand = mulberry32(0x5eed + iteration * 977 + shape.length * 31);
        const count = 1 + Math.floor(rand() * 40);
        const base = rawSpanSet(shape, rand, count);
        for (const raw of [base, shuffled(base, rand)]) {
          for (const [minSpan, mergeGap] of [
            [40, 60],
            [0, 0],
            [10, 500],
          ]) {
            expect(
              resolveFlowOverlaps(raw, minSpan, mergeGap),
              `${shape}/${iteration}/${minSpan}`,
            ).toEqual(legacyResolveOverlaps(raw, minSpan, mergeGap));
            cases++;
          }
        }
      }
    }
    expect(cases).toBe(shapes.length * 40 * 2 * 3);
  });

  it("gives an interval to the first submitted span when severities tie", () => {
    // `queuing` and a measured 40% of free flow both rank 3, and they differ in
    // `los`, so the merge cannot hide which of the two owned the overlap.
    const first: RankedFlowSpan = {
      startMeters: 0,
      endMeters: 200,
      los: "queuing",
      confidence: "measured",
      rank: flowSeverityRank("queuing"),
    };
    const second: RankedFlowSpan = {
      startMeters: 100,
      endMeters: 300,
      los: "free_flow",
      confidence: "measured",
      speedRatio: 0.4,
      rank: flowSeverityRank("free_flow", 0.4),
    };
    expect(first.rank).toBe(second.rank);
    const shape = (spans: RouteFlowSpan[]): Array<[number, number, string]> =>
      spans.map((s) => [s.startMeters, s.endMeters, s.los]);
    // The overlap (100..200) goes to whichever of the two was submitted first,
    // and the merge then hands it to that span's neighbouring interval.
    expect(shape(resolveFlowOverlaps([first, second], 40, 0))).toEqual([
      [0, 200, "queuing"],
      [200, 300, "free_flow"],
    ]);
    expect(shape(resolveFlowOverlaps([second, first], 40, 0))).toEqual([
      [0, 100, "queuing"],
      [100, 300, "free_flow"],
    ]);
    expect(resolveFlowOverlaps([first, second], 40, 0)).toEqual(
      legacyResolveOverlaps([first, second], 40, 0),
    );
    expect(resolveFlowOverlaps([second, first], 40, 0)).toEqual(
      legacyResolveOverlaps([second, first], 40, 0),
    );
  });

  it("returns nothing for no spans at all", () => {
    expect(resolveFlowOverlaps([], 40, 60)).toEqual([]);
  });
});

describe("route flow scaling", () => {
  const counters = (): FlowOverlapCounters => ({
    heapOperations: 0,
    comparisons: 0,
    intervals: 0,
  });

  for (const shape of ["disjoint", "nested", "crossing"]) {
    it(`stays sub-quadratic from 5k to 10k ${shape} spans`, () => {
      const measure = (count: number): FlowOverlapCounters => {
        const spans = rawSpanSet(shape, mulberry32(0x5ca1e), count);
        const taken = counters();
        resolveFlowOverlaps(spans, 0, 0, taken);
        return taken;
      };
      const small = measure(5_000);
      const large = measure(10_000);
      // Doubling the input roughly doubles the work. The all-pairs resolver
      // this replaced grew about fourfold: 5,000 spans cost it ~50 million
      // membership checks, and the assertions below are orders of magnitude
      // under that.
      const growth = large.comparisons / small.comparisons;
      expect(growth).toBeGreaterThan(1.5);
      expect(growth).toBeLessThan(3);
      expect(large.comparisons).toBeLessThan(10_000 * 60);
      expect(large.heapOperations).toBeLessThanOrEqual(2 * 10_000);
      expect(large.intervals).toBeGreaterThan(0);
    });
  }

  it("keeps ties deterministic when equal-rank spans are shuffled", () => {
    const rand = mulberry32(0x71e5);
    const base = Array.from({ length: 5_000 }, (_, i) => ({
      startMeters: i * 10,
      endMeters: i * 10 + 500,
      los: "heavy" as const,
      confidence: "measured" as const,
      rank: 2,
      currentSpeedKph: i,
    }));
    const mixed = shuffled(base, rand);
    expect(resolveFlowOverlaps(mixed, 0, 0)).toEqual(legacyResolveOverlaps(mixed, 0, 0));
  });

  it("prepares one matcher per route and evaluates few edges per sample", () => {
    const points = 5_000;
    const meters = 500_000;
    const route: LngLat[] = Array.from(
      { length: points },
      (_, i) => [8, 50 + meters * (i / (points - 1)) * M] as LngLat,
    );
    const segments = Array.from({ length: 100 }, (_, s) =>
      segment(
        Array.from({ length: 20 }, (_, i) => {
          const start = (meters * s) / 100;
          return [8, 50 + (start + i * 100) * M] as LngLat;
        }),
        { id: `s${s}` },
      ),
    );

    resetRouteMatcherCounters();
    setRouteMatcherCounting(true);
    try {
      const spans = projectFlowToRoute(segments, route);
      expect(spans.length).toBeGreaterThan(50);
      const taken = readRouteMatcherCounters();
      expect(taken.preparations).toBe(1);
      expect(taken.snaps).toBe(100 * 20);
      // A whole-route scan would be 4,999 edges per sample.
      expect(taken.evaluatedEdges / taken.snaps).toBeLessThan(64);
    } finally {
      setRouteMatcherCounting(false);
      resetRouteMatcherCounters();
    }
  });
});
