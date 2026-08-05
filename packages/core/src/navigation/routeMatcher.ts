import { degreesToRadians, earthRadius, lineString, point, radiansToLength } from "@turf/helpers";
import nearestPointOnLine from "@turf/nearest-point-on-line";
import type { LngLat } from "../types/geometry";
import type { SnapResult } from "./types";

/**
 * A route polyline with an immutable spherical index over its edges, so a fix
 * can be projected without scanning the whole line. Prepare once per route
 * geometry identity and reuse it for every query against that route; the index
 * is only valid for the exact array it was built from.
 *
 * The result of {@link snapPreparedRoute} is identical — coordinates, index and
 * both distances, to the last bit — to {@link snapToRoute} on the same
 * geometry. Edges are only skipped when a conservative spherical lower bound
 * proves they cannot beat the best exact result found so far, and the survivors
 * are evaluated with the same Turf primitive.
 */
export interface PreparedRouteMatcher {
  /** The geometry this index describes. Identity doubles as the cache key. */
  readonly geometry: LngLat[];
}

/** Diagnostic operation counts, off by default. Never logged. */
export interface RouteMatcherCounters {
  /** Indexes actually built (cache hits and reused matchers do not count). */
  preparations: number;
  /** Calls to {@link snapPreparedRoute}. */
  snaps: number;
  /** Edges handed to the exact Turf evaluation. */
  evaluatedEdges: number;
  /** Hierarchy nodes whose bound was tested. */
  visitedNodes: number;
}

const METERS = { units: "meters" } as const;

/**
 * Edges per leaf. Large enough that the bound test pays for itself, small
 * enough that a near-route fix evaluates a handful of edges rather than a block.
 */
const LEAF_EDGES = 8;

/**
 * Slack (radians) added to every cap so that an edge is never excluded by
 * rounding alone. It also covers the exact-vertex cases, where the projection
 * returns one of the endpoints.
 */
const CAP_FLOOR_RADIANS = 1e-8;

/**
 * The projection of a query onto a segment is computed from `A × B`, whose
 * direction loses roughly `eps / sin(theta)` radians of accuracy on a short
 * edge. Widening each cap by that much keeps the bound conservative for the
 * point Turf actually returns rather than the point it ideally would; on a
 * genuinely degenerate edge it grows until the edge is effectively always
 * evaluated, which is the correct outcome.
 */
const CAP_DIRECTION_SLACK = 32 * Number.EPSILON;

/**
 * Caps wider than this contribute nothing (they cover a large part of every
 * query's neighbourhood) and would poison their ancestors, so such edges are
 * evaluated unconditionally instead. ~318 km of angular radius.
 */
const MAX_CAP_RADIANS = 0.05;

/** Beyond this an edge spans close to half the globe and the cap is unreliable. */
const MAX_EDGE_RADIANS = Math.PI - 1e-6;

/** A node whose children point in opposing directions cannot be bounded usefully. */
const MIN_CENTRE_MAGNITUDE = 1e-9;

/** Absolute slack (m) on every prune comparison. */
const PRUNE_ABS_METERS = 1e-6;
/** Relative slack on every prune comparison, far above the ~1e-16 of a double. */
const PRUNE_REL = 1e-9;

/**
 * Turf reports "no segment matched" with these values, and reaches them
 * whenever every distance is NaN. Reproduced so a poisoned geometry behaves
 * identically here.
 */
const NO_MATCH_SNAPPED: LngLat = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];

interface MatcherIndex {
  readonly coords: LngLat[];
  /** Edge count, `coords.length - 1` (never negative). */
  readonly edges: number;
  /**
   * Arc-length from the route start to each vertex, accumulated in ascending
   * edge order with Turf's own haversine so route-global `alongMeters` matches
   * bit for bit.
   */
  readonly prefix: Float64Array;
  /** Per-edge cap centre (unit sphere) and angular radius, radians. */
  readonly capX: Float64Array;
  readonly capY: Float64Array;
  readonly capZ: Float64Array;
  readonly capR: Float64Array;
  /** Edges with no usable cap. Always evaluated. */
  readonly always: Int32Array;
  /** Edges carried by the hierarchy, ascending. Leaves index into this. */
  readonly indexed: Int32Array;
  readonly nodeX: Float64Array;
  readonly nodeY: Float64Array;
  readonly nodeZ: Float64Array;
  readonly nodeR: Float64Array;
  readonly nodeLo: Int32Array;
  readonly nodeHi: Int32Array;
  readonly nodeLeft: Int32Array;
  readonly nodeRight: Int32Array;
  /** Root node, or -1 when nothing could be indexed. */
  readonly root: number;
  /** Geometry with a non-finite coordinate: skip the index, scan everything. */
  readonly exhaustive: boolean;
}

interface IndexedMatcher extends PreparedRouteMatcher {
  readonly [INTERNALS]: MatcherIndex;
}

const INTERNALS = Symbol("openmapx.routeMatcher");

const counters: RouteMatcherCounters = {
  preparations: 0,
  snaps: 0,
  evaluatedEdges: 0,
  visitedNodes: 0,
};
let counting = false;

/** Turn the diagnostic counters on or off. Off in normal operation. */
export function setRouteMatcherCounting(enabled: boolean): void {
  counting = enabled;
}

/** Read the diagnostic counters. Zeroes unless counting is enabled. */
export function readRouteMatcherCounters(): RouteMatcherCounters {
  return { ...counters };
}

/** Zero the diagnostic counters. */
export function resetRouteMatcherCounters(): void {
  counters.preparations = 0;
  counters.snaps = 0;
  counters.evaluatedEdges = 0;
  counters.visitedNodes = 0;
}

/**
 * Great-circle distance in metres, mirroring `@turf/distance` exactly —
 * including the `% 360` in `degreesToRadians` and the operation order — because
 * the cumulative distances it feeds must reproduce Turf's running total to the
 * last bit. (Turf writes the squares as `Math.pow(x, 2)`; `x ** 2` is the same
 * operation, and the tests compare the result against Turf's own output.)
 */
function turfDistanceMeters(from: LngLat, to: LngLat): number {
  const dLat = degreesToRadians(to[1] - from[1]);
  const dLon = degreesToRadians(to[0] - from[0]);
  const lat1 = degreesToRadians(from[1]);
  const lat2 = degreesToRadians(to[1]);
  const a = Math.sin(dLat / 2) ** 2 + Math.sin(dLon / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return radiansToLength(2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)), "meters");
}

/**
 * Unit vector for a lng/lat, matching the conversion inside
 * `nearestPointOnLine` so the degenerate-segment test below lands on exactly
 * the same branch Turf takes.
 */
function unitVector(p: LngLat, out: Float64Array, at: number): void {
  const lat = degreesToRadians(p[1]);
  const lng = degreesToRadians(p[0]);
  const cosLat = Math.cos(lat);
  out[at] = cosLat * Math.cos(lng);
  out[at + 1] = cosLat * Math.sin(lng);
  out[at + 2] = Math.sin(lat);
}

/** Angle (radians) between two unit vectors, stable at both ends of the range. */
function angleBetween(
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
): number {
  const cx = ay * bz - az * by;
  const cy = az * bx - ax * bz;
  const cz = ax * by - ay * bx;
  return Math.atan2(Math.sqrt(cx * cx + cy * cy + cz * cz), ax * bx + ay * by + az * bz);
}

/**
 * Distance (m) below which no point of the cap can lie. `angle(q, centre)`
 * minus the cap radius is a lower bound on the angle to every point inside the
 * cap, and Turf's distance is exactly that angle times the sphere radius.
 */
function capLowerBound(
  qx: number,
  qy: number,
  qz: number,
  cx: number,
  cy: number,
  cz: number,
  radius: number,
): number {
  const remaining = angleBetween(qx, qy, qz, cx, cy, cz) - radius;
  return remaining > 0 ? remaining * earthRadius : 0;
}

/** Whether a bound proves a whole subtree is worse than the best exact result. */
function prunable(lowerBound: number, best: number): boolean {
  const slack = PRUNE_ABS_METERS + PRUNE_REL * (Math.abs(lowerBound) + Math.abs(best));
  return lowerBound - slack > best;
}

function buildIndex(geometry: LngLat[]): MatcherIndex {
  const n = geometry.length;
  const edges = Math.max(0, n - 1);

  let finite = true;
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(geometry[i][0]) || !Number.isFinite(geometry[i][1])) {
      finite = false;
      break;
    }
  }

  const prefix = new Float64Array(n);
  for (let i = 0; i < edges; i++) {
    prefix[i + 1] = prefix[i] + turfDistanceMeters(geometry[i], geometry[i + 1]);
  }

  const empty = new Int32Array(0);
  const emptyF = new Float64Array(0);
  if (!finite || edges === 0) {
    return {
      coords: geometry,
      edges,
      prefix,
      capX: emptyF,
      capY: emptyF,
      capZ: emptyF,
      capR: emptyF,
      always: empty,
      indexed: empty,
      nodeX: emptyF,
      nodeY: emptyF,
      nodeZ: emptyF,
      nodeR: emptyF,
      nodeLo: empty,
      nodeHi: empty,
      nodeLeft: empty,
      nodeRight: empty,
      root: -1,
      exhaustive: true,
    };
  }

  // Vertex unit vectors, shared by the two edges that meet at each vertex.
  const vec = new Float64Array(n * 3);
  for (let i = 0; i < n; i++) unitVector(geometry[i], vec, i * 3);

  const capX = new Float64Array(edges);
  const capY = new Float64Array(edges);
  const capZ = new Float64Array(edges);
  const capR = new Float64Array(edges);
  const indexedList: number[] = [];
  const alwaysList: number[] = [];

  for (let i = 0; i < edges; i++) {
    const a = i * 3;
    const b = a + 3;
    const ax = vec[a];
    const ay = vec[a + 1];
    const az = vec[a + 2];
    const bx = vec[b];
    const by = vec[b + 1];
    const bz = vec[b + 2];

    const crx = ay * bz - az * by;
    const cry = az * bx - ax * bz;
    const crz = ax * by - ay * bx;
    const dot = ax * bx + ay * by + az * bz;
    const crossMag = Math.sqrt(crx * crx + cry * cry + crz * crz);

    let cx: number;
    let cy: number;
    let cz: number;
    let radius: number;

    if (crx === 0 && cry === 0 && crz === 0) {
      // Turf's own degenerate branch: with a zero segment axis it returns the
      // segment's end point for a same-direction pair, and the query itself for
      // an antipodal one — the latter has no bounding cap at all.
      if (!(dot > 0)) {
        alwaysList.push(i);
        continue;
      }
      cx = bx;
      cy = by;
      cz = bz;
      radius = angleBetween(bx, by, bz, ax, ay, az) + CAP_FLOOR_RADIANS;
    } else {
      const theta = Math.atan2(crossMag, dot);
      if (!(theta < MAX_EDGE_RADIANS)) {
        alwaysList.push(i);
        continue;
      }
      const mx = ax + bx;
      const my = ay + by;
      const mz = az + bz;
      const mag = Math.sqrt(mx * mx + my * my + mz * mz);
      if (!(mag > MIN_CENTRE_MAGNITUDE)) {
        alwaysList.push(i);
        continue;
      }
      cx = mx / mag;
      cy = my / mag;
      cz = mz / mag;
      // The minor arc is centred on the normalised midpoint direction, so half
      // the edge's own angle encloses it. Measure both ends rather than assume
      // the symmetry survives rounding.
      const rA = angleBetween(cx, cy, cz, ax, ay, az);
      const rB = angleBetween(cx, cy, cz, bx, by, bz);
      radius =
        Math.max(rA, rB) + CAP_FLOOR_RADIANS + CAP_DIRECTION_SLACK / Math.max(crossMag, 1e-300);
    }

    if (!(radius < MAX_CAP_RADIANS)) {
      alwaysList.push(i);
      continue;
    }
    capX[i] = cx;
    capY[i] = cy;
    capZ[i] = cz;
    capR[i] = radius;
    indexedList.push(i);
  }

  const indexed = Int32Array.from(indexedList);
  const always = Int32Array.from(alwaysList);

  // A balanced tree over contiguous runs of the indexed edges. Route vertices
  // arrive in travel order, so neighbouring edges are already spatially close
  // and no separate spatial sort is needed to get tight node bounds.
  // Halving stops at `LEAF_EDGES`, so the smallest leaf a split can produce
  // holds half of `LEAF_EDGES + 1` rounded down.
  const minLeaf = (LEAF_EDGES + 1) >> 1;
  const capacity = 2 * Math.ceil(Math.max(1, indexed.length) / minLeaf) + 2;
  const nodeX = new Float64Array(capacity);
  const nodeY = new Float64Array(capacity);
  const nodeZ = new Float64Array(capacity);
  const nodeR = new Float64Array(capacity);
  const nodeLo = new Int32Array(capacity);
  const nodeHi = new Int32Array(capacity);
  const nodeLeft = new Int32Array(capacity).fill(-1);
  const nodeRight = new Int32Array(capacity).fill(-1);
  let nodeCount = 0;

  const combine = (node: number, ax: number, ay: number, az: number, ar: number, other: number) => {
    const bx = nodeX[other];
    const by = nodeY[other];
    const bz = nodeZ[other];
    const br = nodeR[other];
    const mx = ax + bx;
    const my = ay + by;
    const mz = az + bz;
    const mag = Math.sqrt(mx * mx + my * my + mz * mz);
    if (!(mag > MIN_CENTRE_MAGNITUDE)) {
      // Children on opposite sides of the globe: keep a centre but let the
      // radius cover everything, so the node never prunes.
      nodeX[node] = ax;
      nodeY[node] = ay;
      nodeZ[node] = az;
      nodeR[node] = Math.PI;
      return;
    }
    const cx = mx / mag;
    const cy = my / mag;
    const cz = mz / mag;
    const ra = angleBetween(cx, cy, cz, ax, ay, az) + ar;
    const rb = angleBetween(cx, cy, cz, bx, by, bz) + br;
    nodeX[node] = cx;
    nodeY[node] = cy;
    nodeZ[node] = cz;
    nodeR[node] = Math.min(Math.PI, Math.max(ra, rb) + CAP_FLOOR_RADIANS);
  };

  const build = (lo: number, hi: number): number => {
    const node = nodeCount++;
    nodeLo[node] = lo;
    nodeHi[node] = hi;
    if (hi - lo <= LEAF_EDGES) {
      // Union of the member caps, grown one member at a time.
      const first = indexed[lo];
      let cx = capX[first];
      let cy = capY[first];
      let cz = capZ[first];
      let r = capR[first];
      for (let p = lo + 1; p < hi; p++) {
        const e = indexed[p];
        const mx = cx + capX[e];
        const my = cy + capY[e];
        const mz = cz + capZ[e];
        const mag = Math.sqrt(mx * mx + my * my + mz * mz);
        if (!(mag > MIN_CENTRE_MAGNITUDE)) {
          r = Math.PI;
          break;
        }
        const nx = mx / mag;
        const ny = my / mag;
        const nz = mz / mag;
        const ra = angleBetween(nx, ny, nz, cx, cy, cz) + r;
        const rb = angleBetween(nx, ny, nz, capX[e], capY[e], capZ[e]) + capR[e];
        cx = nx;
        cy = ny;
        cz = nz;
        r = Math.max(ra, rb) + CAP_FLOOR_RADIANS;
      }
      nodeX[node] = cx;
      nodeY[node] = cy;
      nodeZ[node] = cz;
      nodeR[node] = Math.min(Math.PI, r);
      return node;
    }
    const mid = (lo + hi) >> 1;
    const left = build(lo, mid);
    const right = build(mid, hi);
    nodeLeft[node] = left;
    nodeRight[node] = right;
    combine(node, nodeX[left], nodeY[left], nodeZ[left], nodeR[left], right);
    return node;
  };

  const root = indexed.length > 0 ? build(0, indexed.length) : -1;

  return {
    coords: geometry,
    edges,
    prefix,
    capX,
    capY,
    capZ,
    capR,
    always,
    indexed,
    nodeX,
    nodeY,
    nodeZ,
    nodeR,
    nodeLo,
    nodeHi,
    nodeLeft,
    nodeRight,
    root,
    exhaustive: false,
  };
}

const CACHE = new WeakMap<LngLat[], PreparedRouteMatcher>();

const isDevelopmentLike = (): boolean => {
  const env = typeof process === "undefined" ? undefined : process.env?.NODE_ENV;
  return env !== "production";
};

/**
 * Build (or reuse) the spherical index for a route geometry. Cached on the
 * array's identity, so re-preparing the same geometry is free and a replaced
 * route drops its index with the array it belonged to.
 */
export function prepareRouteMatcher(geometry: LngLat[]): PreparedRouteMatcher {
  const cached = CACHE.get(geometry);
  if (cached) return cached;
  if (counting) counters.preparations++;
  const prepared: IndexedMatcher = { geometry, [INTERNALS]: buildIndex(geometry) };
  if (isDevelopmentLike()) Object.freeze(prepared);
  CACHE.set(geometry, prepared);
  return prepared;
}

/** Route geometry, or an already-prepared matcher for it. */
export type RouteMatcherInput = LngLat[] | PreparedRouteMatcher;

/**
 * Resolve a geometry-or-matcher argument. Preparing here is the compatibility
 * path for one-shot callers; batch callers should prepare once at their own
 * identity boundary and pass the matcher down.
 */
export function asRouteMatcher(input: RouteMatcherInput): PreparedRouteMatcher {
  return Array.isArray(input) ? prepareRouteMatcher(input) : input;
}

/**
 * Signal that a caller handed over a prepared object built for something other
 * than what it is being used with. Its owner let the two drift apart, so the
 * prepared object is discarded either way; under test that is a hard failure,
 * in development a warning, and in production a silent rebuild.
 */
export function reportPreparedMismatch(what: string): void {
  const message = `${what} does not belong to the input it was used with`;
  if (typeof process !== "undefined" && process.env?.NODE_ENV === "test") {
    throw new Error(message);
  }
  if (isDevelopmentLike()) console.warn(`[navigation] ${message}`);
}

/**
 * The matcher to use for `geometry`, given one a caller supplied. A matcher
 * built for a different geometry is never used: that means the caller's route
 * was replaced without its matcher being replaced.
 */
export function routeMatcherFor(
  geometry: LngLat[],
  supplied?: PreparedRouteMatcher | null,
): PreparedRouteMatcher {
  if (supplied) {
    if (supplied.geometry === geometry) return supplied;
    reportPreparedMismatch("route matcher");
  }
  return prepareRouteMatcher(geometry);
}

/**
 * Project a raw fix onto a prepared route. Identical in every field to
 * {@link snapToRoute} on the same geometry.
 *
 * `seedSegmentIndex` may name an edge to evaluate first — typically the
 * previous result's `segmentIndex` — which tightens the bound early. It only
 * ever changes the order edges are considered in, never which ones qualify.
 */
export function snapPreparedRoute(
  prepared: PreparedRouteMatcher,
  raw: LngLat,
  seedSegmentIndex?: number,
): SnapResult {
  const idx = (prepared as IndexedMatcher)[INTERNALS];
  if (!idx) throw new Error("not a prepared route matcher");
  if (counting) counters.snaps++;

  const coords = idx.coords;
  // Turf builds the line before the point, so a route too short to be a line
  // must fail with the line's error even when the fix is unusable too.
  if (idx.edges === 0) lineString(coords);
  const inputPoint = point(raw);

  let bestDist = Number.POSITIVE_INFINITY;
  let bestEdge = -1;
  let bestSnapped: LngLat = NO_MATCH_SNAPPED;
  let bestAlong = -1;
  let bestIndex = -1;

  const evaluate = (edge: number): void => {
    if (counting) counters.evaluatedEdges++;
    const local = nearestPointOnLine(
      lineString([coords[edge], coords[edge + 1]]),
      inputPoint,
      METERS,
    );
    const dist = local.properties.dist as number;
    // Strictly closer wins; an equal distance only wins for an earlier edge,
    // which is what Turf's ascending scan with a strict comparison produces.
    if (dist < bestDist || (bestEdge >= 0 && dist === bestDist && edge < bestEdge)) {
      bestDist = dist;
      bestEdge = edge;
      bestSnapped = local.geometry.coordinates as LngLat;
      bestIndex = edge + (local.properties.index as number);
      bestAlong = idx.prefix[edge] + (local.properties.location as number);
    }
  };

  if (idx.exhaustive) {
    for (let i = 0; i < idx.edges; i++) evaluate(i);
    return {
      snapped: bestSnapped,
      alongMeters: bestAlong,
      deviationMeters: bestDist,
      segmentIndex: bestIndex,
    };
  }

  for (let i = 0; i < idx.always.length; i++) evaluate(idx.always[i]);

  if (seedSegmentIndex !== undefined && idx.indexed.length > 0) {
    const seed = Math.max(0, Math.min(idx.edges - 1, Math.trunc(seedSegmentIndex)));
    if (Number.isFinite(seed) && idx.capR[seed] > 0) evaluate(seed);
  }

  if (idx.root >= 0) {
    const vq = new Float64Array(3);
    unitVector(raw, vq, 0);
    const qx = vq[0];
    const qy = vq[1];
    const qz = vq[2];

    const visit = (node: number): void => {
      if (counting) counters.visitedNodes++;
      const left = idx.nodeLeft[node];
      if (left < 0) {
        const hi = idx.nodeHi[node];
        for (let p = idx.nodeLo[node]; p < hi; p++) {
          const e = idx.indexed[p];
          const bound = capLowerBound(
            qx,
            qy,
            qz,
            idx.capX[e],
            idx.capY[e],
            idx.capZ[e],
            idx.capR[e],
          );
          if (prunable(bound, bestDist)) continue;
          evaluate(e);
        }
        return;
      }
      const right = idx.nodeRight[node];
      const boundL = capLowerBound(
        qx,
        qy,
        qz,
        idx.nodeX[left],
        idx.nodeY[left],
        idx.nodeZ[left],
        idx.nodeR[left],
      );
      const boundR = capLowerBound(
        qx,
        qy,
        qz,
        idx.nodeX[right],
        idx.nodeY[right],
        idx.nodeZ[right],
        idx.nodeR[right],
      );
      // Descend into the more promising child first so its exact result can
      // prune the other one.
      const firstNode = boundL <= boundR ? left : right;
      const secondNode = boundL <= boundR ? right : left;
      const firstBound = boundL <= boundR ? boundL : boundR;
      const secondBound = boundL <= boundR ? boundR : boundL;
      if (!prunable(firstBound, bestDist)) visit(firstNode);
      if (!prunable(secondBound, bestDist)) visit(secondNode);
    };

    const rootBound = capLowerBound(
      qx,
      qy,
      qz,
      idx.nodeX[idx.root],
      idx.nodeY[idx.root],
      idx.nodeZ[idx.root],
      idx.nodeR[idx.root],
    );
    if (!prunable(rootBound, bestDist)) visit(idx.root);
  }

  return {
    snapped: bestSnapped,
    alongMeters: bestAlong,
    deviationMeters: bestDist,
    segmentIndex: bestIndex,
  };
}

/**
 * Read-only view of the prepared index, for structural tests that have to prove
 * every cap encloses what it claims to.
 */
export interface RouteMatcherShape {
  readonly edges: number;
  readonly indexed: readonly number[];
  readonly always: readonly number[];
  readonly exhaustive: boolean;
  readonly prefix: readonly number[];
  edgeCap(edge: number): { x: number; y: number; z: number; r: number } | null;
  /** Nodes from the root down to (and including) the leaf holding `edge`. */
  ancestorCaps(edge: number): { x: number; y: number; z: number; r: number }[];
}

/** Expose the index's shape. Intended for tests and diagnostics only. */
export function inspectRouteMatcher(prepared: PreparedRouteMatcher): RouteMatcherShape {
  const idx = (prepared as IndexedMatcher)[INTERNALS];
  if (!idx) throw new Error("not a prepared route matcher");
  const indexed = Array.from(idx.indexed);
  return {
    edges: idx.edges,
    indexed,
    always: Array.from(idx.always),
    exhaustive: idx.exhaustive,
    prefix: Array.from(idx.prefix),
    edgeCap(edge) {
      if (!indexed.includes(edge)) return null;
      return { x: idx.capX[edge], y: idx.capY[edge], z: idx.capZ[edge], r: idx.capR[edge] };
    },
    ancestorCaps(edge) {
      const position = indexed.indexOf(edge);
      const chain: { x: number; y: number; z: number; r: number }[] = [];
      if (position < 0 || idx.root < 0) return chain;
      let node = idx.root;
      for (;;) {
        chain.push({
          x: idx.nodeX[node],
          y: idx.nodeY[node],
          z: idx.nodeZ[node],
          r: idx.nodeR[node],
        });
        const left = idx.nodeLeft[node];
        if (left < 0) return chain;
        node = position < idx.nodeHi[left] ? left : idx.nodeRight[node];
      }
    },
  };
}
