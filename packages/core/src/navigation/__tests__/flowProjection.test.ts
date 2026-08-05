import { describe, expect, it } from "vitest";
import type { RoadFlowSegment } from "../../types/roadConditions";
import { projectFlowToRoute, routeFingerprint } from "../flowProjection";

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
