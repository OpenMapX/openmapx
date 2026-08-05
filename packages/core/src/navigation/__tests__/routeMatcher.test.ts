import { degreesToRadians, earthRadius, radiansToDegrees } from "@turf/helpers";
import { beforeEach, describe, expect, it } from "vitest";
import type { LngLat } from "../../types/geometry";
import {
  asRouteMatcher,
  inspectRouteMatcher,
  prepareRouteMatcher,
  readRouteMatcherCounters,
  resetRouteMatcherCounters,
  routeMatcherFor,
  setRouteMatcherCounting,
  snapPreparedRoute,
} from "../routeMatcher";
import { snapToRoute } from "../snap";

/**
 * Every assertion in this file treats {@link snapToRoute} — the untouched Turf
 * path — as the oracle and requires the prepared matcher to reproduce all four
 * `SnapResult` fields exactly, including the distances. `toEqual` compares
 * numbers with `Object.is`, so a single differing bit fails.
 */
function expectSameSnap(geometry: LngLat[], raw: LngLat, label: string): void {
  const oracle = snapToRoute(geometry, raw);
  const prepared = snapPreparedRoute(prepareRouteMatcher(geometry), raw);
  expect(prepared, label).toEqual(oracle);
}

/** Deterministic PRNG so the randomized matrix is reproducible. */
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
  const lat = degreesToRadians(p[1]);
  const lng = degreesToRadians(p[0]);
  return [Math.cos(lat) * Math.cos(lng), Math.cos(lat) * Math.sin(lng), Math.sin(lat)];
}

function vectorToLngLat(v: [number, number, number]): LngLat {
  return [
    radiansToDegrees(Math.atan2(v[1], v[0])),
    radiansToDegrees(Math.asin(Math.min(1, Math.max(-1, v[2])))),
  ];
}

function angleBetween(a: readonly number[], b: readonly number[]): number {
  const cx = a[1] * b[2] - a[2] * b[1];
  const cy = a[2] * b[0] - a[0] * b[2];
  const cz = a[0] * b[1] - a[1] * b[0];
  return Math.atan2(
    Math.sqrt(cx * cx + cy * cy + cz * cz),
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  );
}

/** A point at fraction `t` along the great-circle arc between two positions. */
function alongArc(a: LngLat, b: LngLat, t: number): LngLat {
  const va = unitVector(a);
  const vb = unitVector(b);
  const omega = angleBetween(va, vb);
  if (omega < 1e-12) return a;
  const s0 = Math.sin((1 - t) * omega) / Math.sin(omega);
  const s1 = Math.sin(t * omega) / Math.sin(omega);
  const v: [number, number, number] = [
    s0 * va[0] + s1 * vb[0],
    s0 * va[1] + s1 * vb[1],
    s0 * va[2] + s1 * vb[2],
  ];
  const mag = Math.hypot(v[0], v[1], v[2]);
  return vectorToLngLat([v[0] / mag, v[1] / mag, v[2] / mag]);
}

/** A meandering route of `points` vertices starting at `origin`. */
function curvedRoute(origin: LngLat, points: number, stepDeg = 0.0009): LngLat[] {
  const out: LngLat[] = [];
  let [lng, lat] = origin;
  for (let i = 0; i < points; i++) {
    out.push([lng, lat]);
    const heading = Math.sin(i / 17) * 1.3 + Math.cos(i / 5) * 0.4;
    lng += Math.cos(heading) * stepDeg;
    lat += Math.sin(heading) * stepDeg;
  }
  return out;
}

const FIXTURES: { name: string; geometry: LngLat[]; points: LngLat[] }[] = [
  {
    name: "straight equatorial line",
    geometry: [
      [0, 0],
      [0.001, 0],
      [0.002, 0],
    ],
    points: [
      [0.0005, 0],
      [0.001, 0],
      [0, 0],
      [0.002, 0],
      [0.0015, 0.0004],
      [-0.01, 0],
      [0.02, 0.02],
    ],
  },
  {
    name: "exact vertices and the final endpoint",
    geometry: [
      [8.5, 50],
      [8.501, 50.0005],
      [8.502, 50.001],
      [8.503, 50.0015],
    ],
    points: [
      [8.5, 50],
      [8.501, 50.0005],
      [8.502, 50.001],
      [8.503, 50.0015],
    ],
  },
  {
    name: "duplicate and zero-length edges",
    geometry: [
      [10, 45],
      [10.001, 45],
      [10.001, 45],
      [10.001, 45],
      [10.002, 45],
      [10.002, 45],
    ],
    points: [
      [10.001, 45],
      [10.0015, 45.00001],
      [10.0005, 44.9999],
      [10.002, 45],
      [10.003, 45],
    ],
  },
  {
    name: "out-and-back overlap",
    geometry: [
      [2, 41],
      [2.002, 41],
      [2.004, 41],
      [2.002, 41],
      [2, 41],
    ],
    points: [
      [2.001, 41],
      [2.003, 41],
      [2.004, 41],
      [2.002, 41],
      [2.001, 41.0002],
      [2.001, 40.9998],
    ],
  },
  {
    name: "closed loop",
    geometry: [
      [12, 55],
      [12.002, 55],
      [12.002, 55.0015],
      [12, 55.0015],
      [12, 55],
    ],
    points: [
      [12.001, 55.00075],
      [12, 55],
      [12.002, 55.0015],
      [12.001, 55],
      [12.001, 55.0015],
      [11.999, 55.0008],
    ],
  },
  {
    name: "self-intersecting figure of eight",
    geometry: [
      [0, 0],
      [0.002, 0.002],
      [0.004, 0],
      [0.002, -0.002],
      [0, 0],
      [0.002, 0.002],
    ],
    points: [
      [0.002, 0],
      [0.001, 0.001],
      [0.003, -0.001],
      [0, 0],
      [0.002, 0.002],
    ],
  },
  {
    name: "equal-distance fork",
    geometry: [
      [0, 0],
      [0.001, 0.001],
      [0, 0],
      [0.001, -0.001],
    ],
    points: [
      [0.0005, 0],
      [0, 0],
      [0.001, 0],
      [-0.0005, 0],
    ],
  },
  {
    name: "hairpin",
    geometry: [
      [7, 46],
      [7.003, 46],
      [7.003, 46.00005],
      [7, 46.00005],
    ],
    points: [
      [7.0015, 46.000025],
      [7.0015, 46],
      [7.0015, 46.00005],
      [7.003, 46.000025],
    ],
  },
  {
    name: "parallel carriageways",
    geometry: [
      [9, 48],
      [9.004, 48],
      [9.004, 48.00012],
      [9, 48.00012],
      [9, 48],
    ],
    points: [
      [9.002, 48.00006],
      [9.002, 48.00005],
      [9.002, 48.00007],
      [9.002, 48],
      [9.002, 48.00012],
    ],
  },
  {
    name: "antimeridian crossing",
    geometry: [
      [179.9, 12],
      [179.95, 12],
      [-179.95, 12],
      [-179.9, 12],
    ],
    points: [
      [180, 12],
      [-180, 12],
      [179.97, 12.0005],
      [-179.97, 11.9995],
      [179.9, 12],
      [0, 0],
    ],
  },
  {
    name: "great-circle bow above latitude 80",
    geometry: [
      [-1, 80],
      [1, 80],
    ],
    points: [
      [0, 80],
      [0, 80.02],
      [0, 79.98],
      [-1, 80],
      [1, 80],
      [0, 0],
    ],
  },
  {
    name: "near polar",
    geometry: [
      [0, 89.9],
      [90, 89.95],
      [180, 89.9],
      [-90, 89.95],
      [0, 89.9],
    ],
    points: [
      [0, 90],
      [0, 89.99],
      [45, 89.93],
      [-135, 89.97],
      [0, -89.9],
    ],
  },
  {
    name: "long edges",
    geometry: [
      [-100, 40],
      [-60, 45],
      [0, 50],
      [40, 45],
    ],
    points: [
      [-80, 44],
      [-30, 49],
      [20, 49],
      [0, 0],
      [-179, -60],
    ],
  },
  {
    name: "near antipodal edge",
    geometry: [
      [0, 0],
      [179.999, 0.0005],
      [179.999, 1],
    ],
    points: [
      [90, 0],
      [-90, 0],
      [179.999, 0.5],
      [0, 0.0001],
    ],
  },
  {
    name: "exactly antipodal edge",
    geometry: [
      [0, 0],
      [180, 0],
      [180, 10],
    ],
    points: [
      [90, 0],
      [45, 20],
      [180, 5],
    ],
  },
  {
    name: "single edge",
    geometry: [
      [4, 52],
      [4.001, 52.001],
    ],
    points: [
      [4.0005, 52.0005],
      [4, 52],
      [4.001, 52.001],
      [5, 53],
    ],
  },
];

describe("route matcher differential fixtures", () => {
  for (const fixture of FIXTURES) {
    it(`matches the Turf oracle: ${fixture.name}`, () => {
      for (const raw of fixture.points) {
        expectSameSnap(fixture.geometry, raw, `${fixture.name} @ ${raw.join(",")}`);
      }
    });
  }

  it("matches the oracle on a long curved route at every kind of offset", () => {
    const geometry = curvedRoute([13.4, 52.5], 400);
    for (let i = 0; i < geometry.length; i++) {
      const v = geometry[i];
      expectSameSnap(geometry, v, `vertex ${i}`);
      expectSameSnap(geometry, [v[0] + 0.00004, v[1] - 0.00004], `near ${i}`);
      expectSameSnap(geometry, [v[0] + 0.05, v[1] + 0.05], `far ${i}`);
    }
    expectSameSnap(geometry, [90, -20], "opposite hemisphere");
  });

  it("survives a route swap without leaking the previous index", () => {
    const first = curvedRoute([2.3, 48.85], 120);
    const second = curvedRoute([2.5, 48.9], 130, 0.0013);
    const a = prepareRouteMatcher(first);
    const b = prepareRouteMatcher(second);
    expect(a).not.toBe(b);
    for (const raw of [first[40], second[40], [2.4, 48.87] as LngLat]) {
      expect(snapPreparedRoute(a, raw)).toEqual(snapToRoute(first, raw));
      expect(snapPreparedRoute(b, raw)).toEqual(snapToRoute(second, raw));
    }
  });
});

describe("route matcher randomized differential matrix", () => {
  it("matches the Turf oracle on 12,000 seeded route/point pairs", () => {
    let pairs = 0;
    let bitIdentical = 0;

    for (const [seedIndex, seed] of [0x0decaf24, 0x71ce5eed].entries()) {
      const rand = mulberry32(seed);
      for (let r = 0; r < 20; r++) {
        // Mix ordinary mid-latitude driving geometry with high latitude, the
        // antimeridian, and southern hemisphere routes.
        const baseLng = rand() * 360 - 180;
        const baseLat = (rand() * 2 - 1) * 88;
        const scale = [0.00002, 0.0004, 0.006, 0.09][Math.floor(rand() * 4)];
        // Every fourth route mixes edge lengths by two orders of magnitude, which
        // is what splits a route across the indexed tree and the always-evaluate
        // list; the rest keep one scale throughout.
        const mixed = r % 4 === 0;
        const count = 6 + Math.floor(rand() * 55);
        const geometry: LngLat[] = [];
        let lng = baseLng;
        let lat = baseLat;
        let heading = rand() * Math.PI * 2;
        for (let i = 0; i < count; i++) {
          geometry.push([lng, lat]);
          // Occasionally repeat a vertex (zero-length edge) or double back.
          const roll = rand();
          if (roll < 0.06 && geometry.length > 1) {
            geometry.push([lng, lat]);
          } else if (roll < 0.12 && geometry.length > 2) {
            heading += Math.PI;
          } else {
            heading += (rand() - 0.5) * 1.6;
          }
          const step = mixed && rand() < 0.25 ? scale * 400 : scale;
          lng += Math.cos(heading) * step;
          lat += Math.sin(heading) * step;
        }

        const matcher = prepareRouteMatcher(geometry);
        for (let p = 0; p < 300; p++) {
          const mode = rand();
          let raw: LngLat;
          if (mode < 0.25) {
            raw = geometry[Math.floor(rand() * geometry.length)];
          } else if (mode < 0.5) {
            const i = Math.floor(rand() * (geometry.length - 1));
            raw = alongArc(geometry[i], geometry[i + 1], rand());
          } else if (mode < 0.85) {
            const i = Math.floor(rand() * geometry.length);
            raw = [
              geometry[i][0] + (rand() - 0.5) * scale * 6,
              geometry[i][1] + (rand() - 0.5) * scale * 6,
            ];
          } else {
            raw = [rand() * 360 - 180, (rand() * 2 - 1) * 89];
          }
          const oracle = snapToRoute(geometry, raw);
          const actual = snapPreparedRoute(matcher, raw);
          pairs++;
          if (
            Object.is(actual.alongMeters, oracle.alongMeters) &&
            Object.is(actual.deviationMeters, oracle.deviationMeters) &&
            actual.segmentIndex === oracle.segmentIndex &&
            Object.is(actual.snapped[0], oracle.snapped[0]) &&
            Object.is(actual.snapped[1], oracle.snapped[1])
          ) {
            bitIdentical++;
          } else {
            expect(actual, `seed ${seedIndex} route ${r} point ${p} @ ${raw.join(",")}`).toEqual(
              oracle,
            );
          }
        }
      }
    }

    expect(pairs).toBe(12_000);
    expect(bitIdentical).toBe(pairs);
  });

  it("matches the oracle when the seeded previous segment is supplied", () => {
    const rand = mulberry32(0x51ee7);
    const geometry = curvedRoute([-73.98, 40.75], 300, 0.0006);
    const matcher = prepareRouteMatcher(geometry);
    let seed = 0;
    for (let i = 0; i < 600; i++) {
      const v = geometry[Math.floor(rand() * geometry.length)];
      const raw: LngLat = [v[0] + (rand() - 0.5) * 0.002, v[1] + (rand() - 0.5) * 0.002];
      const oracle = snapToRoute(geometry, raw);
      expect(snapPreparedRoute(matcher, raw, seed)).toEqual(oracle);
      // Deliberately feed back both sensible and nonsense seeds.
      seed = i % 7 === 0 ? -50 : i % 11 === 0 ? 10_000 : oracle.segmentIndex;
    }
  });
});

describe("route matcher spherical bounds", () => {
  const containmentFixtures: { name: string; geometry: LngLat[] }[] = [
    { name: "latitude 80 bow", geometry: FIXTURES[10].geometry },
    { name: "near polar ring", geometry: FIXTURES[11].geometry },
    { name: "antimeridian", geometry: FIXTURES[9].geometry },
    { name: "long edges", geometry: FIXTURES[12].geometry },
    { name: "curved city route", geometry: curvedRoute([4.9, 52.37], 200) },
  ];

  for (const { name, geometry } of containmentFixtures) {
    it(`encloses every sampled arc point in its leaf and all ancestors: ${name}`, () => {
      const shape = inspectRouteMatcher(prepareRouteMatcher(geometry));
      expect(shape.exhaustive).toBe(false);
      for (const edge of shape.indexed) {
        const cap = shape.edgeCap(edge);
        expect(cap, `edge ${edge}`).not.toBeNull();
        if (!cap) continue;
        const ancestors = shape.ancestorCaps(edge);
        expect(ancestors.length).toBeGreaterThan(0);
        for (let s = 0; s <= 20; s++) {
          const sample = unitVector(alongArc(geometry[edge], geometry[edge + 1], s / 20));
          expect(
            angleBetween(sample, [cap.x, cap.y, cap.z]),
            `${name} edge ${edge}`,
          ).toBeLessThanOrEqual(cap.r);
          for (const node of ancestors) {
            expect(
              angleBetween(sample, [node.x, node.y, node.z]),
              `${name} edge ${edge} ancestor`,
            ).toBeLessThanOrEqual(node.r);
          }
        }
      }
    });
  }

  it("the latitude-80 arc leaves the latitude box its endpoints imply", () => {
    const bowed = alongArc([-1, 80], [1, 80], 0.5);
    expect(bowed[1]).toBeGreaterThan(80);
    // A bound derived from the endpoints' latitudes would exclude the arc's own
    // midpoint; the spherical cap contains it.
    const shape = inspectRouteMatcher(prepareRouteMatcher(FIXTURES[10].geometry));
    const cap = shape.edgeCap(0);
    expect(cap).not.toBeNull();
    if (cap) {
      expect(angleBetween(unitVector(bowed), [cap.x, cap.y, cap.z])).toBeLessThanOrEqual(cap.r);
    }
  });

  it("puts unbounded edges on the always-evaluate list rather than in the tree", () => {
    const antipodal = inspectRouteMatcher(prepareRouteMatcher(FIXTURES[14].geometry));
    expect(Array.from(antipodal.always)).toContain(0);
    const longEdges = inspectRouteMatcher(prepareRouteMatcher(FIXTURES[12].geometry));
    expect(longEdges.always.length + longEdges.indexed.length).toBe(longEdges.edges);
  });

  it("reproduces Turf's cumulative distances exactly", () => {
    const geometry = curvedRoute([151.2, -33.87], 250, 0.0011);
    const shape = inspectRouteMatcher(prepareRouteMatcher(geometry));
    for (let i = 1; i < geometry.length; i++) {
      // Snapping a vertex onto the prefix of the route it ends returns exactly
      // that vertex's cumulative distance through the untouched Turf path.
      const oracle = snapToRoute(geometry.slice(0, i + 1), geometry[i]);
      expect(shape.prefix[i]).toBe(oracle.alongMeters);
    }
  });

  it("accumulates edge lengths bit-identically to Turf's own distance", () => {
    const rand = mulberry32(0xd157);
    for (let i = 0; i < 4000; i++) {
      const a: LngLat = [rand() * 360 - 180, (rand() * 2 - 1) * 89.9];
      const scale = [1e-7, 1e-4, 0.01, 3, 60][Math.floor(rand() * 5)];
      const b: LngLat = [a[0] + (rand() - 0.5) * scale, a[1] + (rand() - 0.5) * scale];
      // Snapping an edge's end point onto that edge short-circuits to the end
      // point, so Turf's reported along-distance *is* its own segment length.
      const turfLength = snapToRoute([a, b], b).alongMeters;
      const shape = inspectRouteMatcher(prepareRouteMatcher([a, b]));
      expect(shape.prefix[1], `${a.join(",")} -> ${b.join(",")}`).toBe(turfLength);
    }
  });
});

/**
 * The single property the whole index rests on: for every edge (and every node
 * above it) the spherical lower bound must never exceed the distance Turf
 * actually reports for that edge. If it can, a prune could discard the true
 * answer. These tests measure the invariant directly rather than inferring it
 * from matching results.
 */
describe("route matcher lower-bound conservatism", () => {
  /** Turf's exact per-edge result, i.e. what a leaf evaluation produces. */
  function edgeSnap(geometry: LngLat[], edge: number, raw: LngLat) {
    return snapToRoute([geometry[edge], geometry[edge + 1]], raw);
  }

  function boundMeters(cap: { x: number; y: number; z: number; r: number }, raw: LngLat): number {
    const remaining = angleBetween(unitVector(raw), [cap.x, cap.y, cap.z]) - cap.r;
    return remaining > 0 ? remaining * earthRadius : 0;
  }

  it("never over-estimates the distance to an edge, and encloses the point Turf returns", () => {
    const rand = mulberry32(0xb0dcafe);
    let checks = 0;
    let tightest = Number.POSITIVE_INFINITY;

    for (let r = 0; r < 60; r++) {
      const scale = [0.00003, 0.0005, 0.008, 0.4][Math.floor(rand() * 4)];
      const geometry: LngLat[] = [];
      let lng = rand() * 360 - 180;
      let lat = (rand() * 2 - 1) * 87;
      let heading = rand() * Math.PI * 2;
      for (let i = 0; i < 40; i++) {
        geometry.push([lng, lat]);
        if (rand() < 0.08 && geometry.length > 1) geometry.push([lng, lat]);
        heading += (rand() - 0.5) * 2.2;
        lng += Math.cos(heading) * scale;
        lat += Math.sin(heading) * scale;
      }
      const shape = inspectRouteMatcher(prepareRouteMatcher(geometry));

      const queries: LngLat[] = [];
      for (let q = 0; q < 12; q++) {
        const pick = Math.floor(rand() * geometry.length);
        queries.push(
          rand() < 0.7
            ? [
                geometry[pick][0] + (rand() - 0.5) * scale * 8,
                geometry[pick][1] + (rand() - 0.5) * scale * 8,
              ]
            : [rand() * 360 - 180, (rand() * 2 - 1) * 89],
        );
        queries.push(geometry[pick]);
      }

      for (const raw of queries) {
        for (const edge of shape.indexed) {
          const cap = shape.edgeCap(edge);
          if (!cap) throw new Error(`indexed edge ${edge} has no cap`);
          const exact = edgeSnap(geometry, edge, raw);
          const label = `route ${r} edge ${edge} @ ${raw.join(",")}`;

          // The bound may never exceed what the exact evaluation reports.
          expect(boundMeters(cap, raw), label).toBeLessThanOrEqual(exact.deviationMeters);
          // ...and the projected point Turf hands back must lie inside the cap.
          expect(
            angleBetween(unitVector(exact.snapped), [cap.x, cap.y, cap.z]),
            `${label} snapped containment`,
          ).toBeLessThanOrEqual(cap.r);
          // Every ancestor bounds the edge at least as loosely as the leaf does.
          for (const node of shape.ancestorCaps(edge)) {
            expect(boundMeters(node, raw), `${label} ancestor`).toBeLessThanOrEqual(
              exact.deviationMeters,
            );
          }
          tightest = Math.min(tightest, exact.deviationMeters - boundMeters(cap, raw));
          checks++;
        }
      }
    }

    expect(checks).toBeGreaterThan(50_000);
    // Slack is never negative, which is the property the pruning relies on.
    expect(tightest).toBeGreaterThanOrEqual(0);
  });

  it("keeps the bound conservative on the fixed pathological geometry too", () => {
    const rand = mulberry32(0x9a71c);
    for (const fixture of FIXTURES) {
      const shape = inspectRouteMatcher(prepareRouteMatcher(fixture.geometry));
      if (shape.exhaustive) continue;
      const queries: LngLat[] = [...fixture.points];
      for (let q = 0; q < 40; q++) queries.push([rand() * 360 - 180, (rand() * 2 - 1) * 89.5]);
      for (const raw of queries) {
        for (const edge of shape.indexed) {
          const cap = shape.edgeCap(edge);
          if (!cap) throw new Error(`indexed edge ${edge} has no cap`);
          const exact = edgeSnap(fixture.geometry, edge, raw);
          const label = `${fixture.name} edge ${edge} @ ${raw.join(",")}`;
          expect(boundMeters(cap, raw), label).toBeLessThanOrEqual(exact.deviationMeters);
          expect(
            angleBetween(unitVector(exact.snapped), [cap.x, cap.y, cap.z]),
            `${label} snapped containment`,
          ).toBeLessThanOrEqual(cap.r);
          for (const node of shape.ancestorCaps(edge)) {
            expect(boundMeters(node, raw), `${label} ancestor`).toBeLessThanOrEqual(
              exact.deviationMeters,
            );
          }
        }
      }
    }
  });
});

describe("route matcher degenerate input", () => {
  it("falls back to a whole-line scan for non-finite geometry", () => {
    const geometry: LngLat[] = [
      [0, 0],
      [0.002, 0],
      [Number.POSITIVE_INFINITY, 0],
    ];
    const shape = inspectRouteMatcher(prepareRouteMatcher(geometry));
    expect(shape.exhaustive).toBe(true);
    expect(snapPreparedRoute(prepareRouteMatcher(geometry), [0.001, 0])).toEqual(
      snapToRoute(geometry, [0.001, 0]),
    );
  });

  it("returns Turf's no-match result when every distance is unusable", () => {
    const geometry: LngLat[] = [
      [0, 0],
      [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY],
    ];
    const result = snapPreparedRoute(prepareRouteMatcher(geometry), [0.001, 0]);
    expect(result).toEqual(snapToRoute(geometry, [0.001, 0]));
    expect(result).toEqual({
      snapped: [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY],
      alongMeters: -1,
      deviationMeters: Number.POSITIVE_INFINITY,
      segmentIndex: -1,
    });
  });

  it("rejects NaN geometry exactly where the oracle does", () => {
    const geometry: LngLat[] = [
      [0, 0],
      [Number.NaN, 0],
      [0.002, 0],
    ];
    expect(() => snapToRoute(geometry, [0.001, 0])).toThrow("coordinates must contain numbers");
    expect(() => snapPreparedRoute(prepareRouteMatcher(geometry), [0.001, 0])).toThrow(
      "coordinates must contain numbers",
    );
  });

  it("throws the same errors as the oracle for unusable arguments", () => {
    const short: LngLat[] = [[0, 0]];
    expect(() => snapToRoute(short, [0, 0])).toThrow();
    expect(() => snapPreparedRoute(prepareRouteMatcher(short), [0, 0])).toThrow(
      "coordinates must be an array of two or more positions",
    );

    const geometry: LngLat[] = [
      [0, 0],
      [0.001, 0],
    ];
    expect(() => snapToRoute(geometry, [Number.NaN, 0])).toThrow();
    expect(() => snapPreparedRoute(prepareRouteMatcher(geometry), [Number.NaN, 0])).toThrow(
      "coordinates must contain numbers",
    );
  });

  it("agrees with the oracle for an infinite fix", () => {
    const geometry: LngLat[] = [
      [0, 0],
      [0.001, 0],
    ];
    const raw: LngLat = [Number.POSITIVE_INFINITY, 0];
    expect(snapPreparedRoute(prepareRouteMatcher(geometry), raw)).toEqual(
      snapToRoute(geometry, raw),
    );
  });
});

describe("route matcher ownership", () => {
  beforeEach(() => {
    resetRouteMatcherCounters();
    setRouteMatcherCounting(true);
  });

  it("prepares once per geometry identity and never again", () => {
    const geometry = curvedRoute([0.1, 51.5], 200);
    const first = prepareRouteMatcher(geometry);
    for (let i = 0; i < 500; i++) {
      expect(prepareRouteMatcher(geometry)).toBe(first);
      snapPreparedRoute(first, [geometry[i % 200][0] + 0.0001, geometry[i % 200][1]]);
    }
    expect(readRouteMatcherCounters().preparations).toBe(1);
    expect(readRouteMatcherCounters().snaps).toBe(500);
    setRouteMatcherCounting(false);
  });

  it("prepares a second index only when the geometry array is replaced", () => {
    const a = curvedRoute([0.1, 51.5], 40);
    const b = curvedRoute([0.2, 51.6], 40);
    prepareRouteMatcher(a);
    prepareRouteMatcher(a);
    prepareRouteMatcher(b);
    prepareRouteMatcher(b);
    expect(readRouteMatcherCounters().preparations).toBe(2);
    setRouteMatcherCounting(false);
  });

  it("accepts a geometry array or a prepared matcher interchangeably", () => {
    const geometry = curvedRoute([0.1, 51.5], 30);
    const prepared = prepareRouteMatcher(geometry);
    expect(asRouteMatcher(geometry)).toBe(prepared);
    expect(asRouteMatcher(prepared)).toBe(prepared);
    setRouteMatcherCounting(false);
  });

  it("refuses a matcher built for different geometry", () => {
    const a = curvedRoute([0.1, 51.5], 20);
    const b = curvedRoute([0.2, 51.6], 20);
    const staleMatcher = prepareRouteMatcher(a);
    expect(routeMatcherFor(a, staleMatcher)).toBe(staleMatcher);
    expect(() => routeMatcherFor(b, staleMatcher)).toThrow(
      "route matcher does not belong to the input it was used with",
    );
    expect(routeMatcherFor(b)).toBe(prepareRouteMatcher(b));
    setRouteMatcherCounting(false);
  });

  it("evaluates a small fraction of the edges for a near-route fix", () => {
    const geometry = curvedRoute([11.57, 48.14], 5000, 0.00035);
    const matcher = prepareRouteMatcher(geometry);
    resetRouteMatcherCounters();
    for (let i = 0; i < 200; i++) {
      const v = geometry[(i * 23) % geometry.length];
      snapPreparedRoute(matcher, [v[0] + 0.00002, v[1] + 0.00002]);
    }
    const evaluated = readRouteMatcherCounters().evaluatedEdges / 200;
    // A whole-line scan would evaluate 4,999 edges per fix.
    expect(evaluated).toBeLessThan(120);
    setRouteMatcherCounting(false);
  });
});

/**
 * Scaling probes. The assertions are on evaluated-edge counts and generous
 * ratios rather than absolute wall times, so a loaded CI machine cannot fail
 * them; set `OPENMAPX_MATCHER_BENCH=1` to print the measured numbers.
 */
describe("route matcher scaling", () => {
  interface Probe {
    points: number;
    prepareMs: number;
    evaluatedPerNearFix: number;
    evaluatedPerFarFix: number;
    preparedUsPerSnap: number;
    oracleUsPerSnap: number;
  }

  function probe(points: number): Probe {
    const geometry = curvedRoute([2.35, 48.86], points, 0.00035);
    const near: LngLat[] = [];
    const far: LngLat[] = [];
    for (let i = 0; i < 200; i++) {
      const v = geometry[(i * 97) % geometry.length];
      near.push([v[0] + 0.00003, v[1] - 0.00003]);
      far.push([v[0] + 0.4, v[1] - 0.4]);
    }

    // Preparation is timed on a geometry the cache has never seen.
    const fresh = geometry.map((c) => [c[0], c[1]] as LngLat);
    const prepareStart = performance.now();
    prepareRouteMatcher(fresh);
    const prepareMs = performance.now() - prepareStart;

    const matcher = prepareRouteMatcher(geometry);

    setRouteMatcherCounting(true);
    resetRouteMatcherCounters();
    for (const raw of near) snapPreparedRoute(matcher, raw);
    const evaluatedPerNearFix = readRouteMatcherCounters().evaluatedEdges / near.length;
    resetRouteMatcherCounters();
    for (const raw of far) snapPreparedRoute(matcher, raw);
    const evaluatedPerFarFix = readRouteMatcherCounters().evaluatedEdges / far.length;
    setRouteMatcherCounting(false);

    // Warm both paths before timing either.
    for (const raw of near) snapPreparedRoute(matcher, raw);
    for (const raw of near.slice(0, 5)) snapToRoute(geometry, raw);

    const preparedStart = performance.now();
    for (let pass = 0; pass < 5; pass++) for (const raw of near) snapPreparedRoute(matcher, raw);
    const preparedUsPerSnap = ((performance.now() - preparedStart) * 1000) / (near.length * 5);

    const oracleRuns = points >= 20_000 ? 20 : 60;
    const oracleStart = performance.now();
    for (let i = 0; i < oracleRuns; i++) snapToRoute(geometry, near[i % near.length]);
    const oracleUsPerSnap = ((performance.now() - oracleStart) * 1000) / oracleRuns;

    return {
      points,
      prepareMs,
      evaluatedPerNearFix,
      evaluatedPerFarFix,
      preparedUsPerSnap,
      oracleUsPerSnap,
    };
  }

  it("evaluates a near-constant number of edges as the route grows", () => {
    const probes = [probe(1000), probe(5000), probe(20_000)];
    if (process.env.OPENMAPX_MATCHER_BENCH) {
      for (const p of probes) {
        console.info(
          `[matcher] ${p.points} pts: prepare ${p.prepareMs.toFixed(2)} ms · ` +
            `edges/near-fix ${p.evaluatedPerNearFix.toFixed(1)} · ` +
            `edges/far-fix ${p.evaluatedPerFarFix.toFixed(1)} · ` +
            `snap ${p.preparedUsPerSnap.toFixed(1)} us vs oracle ` +
            `${p.oracleUsPerSnap.toFixed(1)} us (${(p.oracleUsPerSnap / p.preparedUsPerSnap).toFixed(1)}x)`,
        );
      }
    }
    const [small, mid, large] = probes;
    // Twenty times the route must not cost anything like twenty times the work.
    expect(large.evaluatedPerNearFix).toBeLessThan(small.evaluatedPerNearFix * 4 + 40);
    expect(mid.evaluatedPerNearFix).toBeLessThan(small.evaluatedPerNearFix * 4 + 40);
    expect(large.evaluatedPerNearFix).toBeLessThan(large.points / 20);
    // Even a fix well off the route stays far below a whole-line scan.
    expect(large.evaluatedPerFarFix).toBeLessThan(large.points / 10);
    // Generous: the measured ratio is far larger, but CI machines are noisy.
    expect(large.preparedUsPerSnap).toBeLessThan(large.oracleUsPerSnap / 5);
    // Preparation stays roughly linear rather than quadratic in route size.
    expect(large.prepareMs).toBeLessThan(Math.max(60, small.prepareMs * 60));
  });
});
