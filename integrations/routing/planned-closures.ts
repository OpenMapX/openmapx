import {
  angularDifference,
  bearingBetween,
  type DirectedExclusion,
  haversineDistance,
  type LngLat,
  type RoadConditionRouteImpact,
  type Route,
  type RoutingOptions,
} from "@openmapx/core";
import {
  dataManagerOperations,
  type PlannedTrafficClosures,
} from "@openmapx/core/data-manager-contracts";
import {
  getGetPlannedTrafficClosuresUrl,
  validateDataManagerBaseUrl,
} from "@openmapx/core/data-manager-sdk";
import { envString } from "@openmapx/core/server-env";
import type { IntegrationContext } from "@openmapx/integration-framework";
import { clearOfEndpoints } from "./local-access.js";

/**
 * Closures for a trip at a later instant. The live-traffic write closes
 * edges only for a depart-now trip, so a planned trip excludes the bound
 * closures in force at its travel instant per request: each as points on the
 * closed carriageway with the direction closed there, which the engine
 * applies to that direction alone. Only closures the returned route actually
 * travels are excluded, then the route is planned again, so a long trip
 * spends its exclusion budget on the closures in its way.
 */

type PlannedClosure = PlannedTrafficClosures["closures"][number];
type Sample = PlannedClosure["samples"][number];

/** A route vertex this near a sample, heading within `ON_ROUTE_HEADING_DEG` of it, travels the closure. */
const ON_ROUTE_DISTANCE_M = 12;
const ON_ROUTE_HEADING_DEG = 45;
/** Planning again stops after this many rounds; a route still on a closure then says so. */
export const MAX_PLANNED_CLOSURE_ROUNDS = 3;
/**
 * Directed points one request may carry: the engine accepts 50 exclusion
 * points in all, and these must never be dropped, so a margin stays for the
 * undirected points of feeds without graph evidence.
 */
export const MAX_DIRECTED_EXCLUSIONS = 40;
/**
 * A sample this near an end of the trip is never excluded: the engine
 * excludes the whole edge under a point, and the end's own edge excluded
 * leaves the trip without a start or destination.
 */
const END_CLEARANCE_M = 150;
/** The box asked about grows by this much around the routes, in degrees. */
const BOX_MARGIN_DEG = 0.02;

/** The bound closures in force at `at` within `bbox`, or null when the evidence is unavailable. */
export async function readPlannedClosures(
  ctx: IntegrationContext,
  bbox: readonly [number, number, number, number],
  at: Date,
): Promise<PlannedTrafficClosures | null> {
  try {
    const token = envString("DATA_MANAGER_AUTH_TOKEN", "").trim();
    if (!token) return null;
    const base = validateDataManagerBaseUrl(
      ctx.getRequiredService("data-manager")?.url ??
        envString("DATA_MANAGER_URL", "http://localhost:4000"),
    );
    const [west, south, east, north] = bbox;
    const url = getGetPlannedTrafficClosuresUrl({ west, south, east, north, at: at.toISOString() });
    const response = await ctx.http.get<unknown>(`${base}${url}`, {
      timeoutMs: 2_000,
      maxResponseBytes: 4 * 1024 * 1024,
      cache: { ttl: 0 },
      headers: { Authorization: `Bearer ${token}`, "Cache-Control": "no-cache" },
    });
    return dataManagerOperations.getPlannedTrafficClosures.responses[200].schema.parse(response);
  } catch (err) {
    ctx.log.warn("[routing] planned closures unavailable", err as Error);
    return null;
  }
}

/** The box around every route's geometry, grown by a margin; null without geometry. */
export function routesBox(routes: readonly Route[]): [number, number, number, number] | null {
  const box: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const route of routes) {
    for (const [lon, lat] of route.geometry) {
      box[0] = Math.min(box[0], lon - BOX_MARGIN_DEG);
      box[1] = Math.min(box[1], lat - BOX_MARGIN_DEG);
      box[2] = Math.max(box[2], lon + BOX_MARGIN_DEG);
      box[3] = Math.max(box[3], lat + BOX_MARGIN_DEG);
    }
  }
  return Number.isFinite(box[0]) ? box : null;
}

/** Route segments bucketed by a coarse grid, so each sample tests only the segments near it. */
const CELL_DEG = 0.005;
function segmentIndex(geometry: readonly LngLat[]): Map<string, number[]> {
  const cells = new Map<string, number[]>();
  for (let i = 0; i + 1 < geometry.length; i++) {
    const a = geometry[i] as LngLat;
    const b = geometry[i + 1] as LngLat;
    const x0 = Math.floor(Math.min(a[0], b[0]) / CELL_DEG);
    const x1 = Math.floor(Math.max(a[0], b[0]) / CELL_DEG);
    const y0 = Math.floor(Math.min(a[1], b[1]) / CELL_DEG);
    const y1 = Math.floor(Math.max(a[1], b[1]) / CELL_DEG);
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        const key = `${x}:${y}`;
        const list = cells.get(key);
        if (list) list.push(i);
        else cells.set(key, [i]);
      }
    }
  }
  return cells;
}

/** Distance in metres from `p` to the segment `a`–`b`, on a local flat projection. */
function distanceToSegment(p: LngLat, a: LngLat, b: LngLat): number {
  const k = Math.cos((p[1] * Math.PI) / 180);
  const dx = (b[0] - a[0]) * k;
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  const t =
    len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * k * dx + (p[1] - a[1]) * dy) / len2));
  return haversineDistance(p, [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
}

/** Whether a route of `geometry`, indexed by `cells`, passes `sample` in the direction it closes. */
function travels(
  geometry: readonly LngLat[],
  cells: Map<string, number[]>,
  sample: Sample,
): boolean {
  const p: LngLat = [sample.lon, sample.lat];
  const cx = Math.floor(sample.lon / CELL_DEG);
  const cy = Math.floor(sample.lat / CELL_DEG);
  for (let x = cx - 1; x <= cx + 1; x++) {
    for (let y = cy - 1; y <= cy + 1; y++) {
      for (const i of cells.get(`${x}:${y}`) ?? []) {
        const a = geometry[i] as LngLat;
        const b = geometry[i + 1] as LngLat;
        if (a[0] === b[0] && a[1] === b[1]) continue;
        if (distanceToSegment(p, a, b) > ON_ROUTE_DISTANCE_M) continue;
        if (angularDifference(bearingBetween(a, b), sample.heading) <= ON_ROUTE_HEADING_DEG)
          return true;
      }
    }
  }
  return false;
}

/**
 * The closures each route travels in their closed direction, with the
 * samples it passed: those are where an exclusion would stop it.
 */
export function closuresOnRoutes(
  routes: readonly Route[],
  closures: readonly PlannedClosure[],
): Map<string, Sample[]> {
  const hits = new Map<string, Sample[]>();
  for (const route of routes) {
    const cells = segmentIndex(route.geometry);
    for (const closure of closures) {
      const passed = closure.samples.filter((s) => travels(route.geometry, cells, s));
      if (passed.length === 0) continue;
      const known = hits.get(closure.id) ?? [];
      for (const s of passed) if (!known.includes(s)) known.push(s);
      hits.set(closure.id, known);
    }
  }
  return hits;
}

/**
 * Whether a closure may be excluded for this trip. A road open to local
 * access stays open where an end of the route lies on it: excluding it would
 * cut the trip's own start or destination off.
 */
function excludable(closure: PlannedClosure, waypoints: readonly LngLat[]): boolean {
  if (!closure.localAccess) return true;
  return clearOfEndpoints(
    closure.samples.map((s) => [s.lon, s.lat] as LngLat),
    waypoints,
  );
}

/** The first and last waypoints: the ends a trip must keep reachable. */
function tripEnds(waypoints: readonly LngLat[]): LngLat[] {
  const first = waypoints[0];
  const last = waypoints[waypoints.length - 1];
  return [first, last].filter((p): p is LngLat => p !== undefined);
}

export interface PlannedClosureOutcome<T> {
  result: T;
  /** Closures a route travelled that later rounds excluded. */
  excluded: string[];
  /** Closures the final routes still travel. */
  onRoute: string[];
}

/**
 * Plans again around the closures the routes of `first` travel, adding the
 * samples each route passed as directed exclusions, for up to
 * `MAX_PLANNED_CLOSURE_ROUNDS` more plans. Exclusions accumulate across
 * rounds; a closure entered past an excluded point is met again and excluded
 * there too. Stops at the directed-exclusion budget, keeping the last result.
 * A plan the exclusions leave impossible (the engine finds no path) keeps the
 * previous result, which still travels the closure and is reported so.
 */
export async function routeAroundPlannedClosures<T extends { routes: Route[] }>(input: {
  first: T;
  closures: readonly PlannedClosure[];
  waypoints: readonly LngLat[];
  options: RoutingOptions;
  plan: (options: RoutingOptions) => Promise<T>;
}): Promise<PlannedClosureOutcome<T>> {
  const byId = new Map(input.closures.map((c) => [c.id, c]));
  const ends = tripEnds(input.waypoints);
  const directed: DirectedExclusion[] = [...(input.options.directedExclusions ?? [])];
  const excluded = new Set<string>();
  let result = input.first;
  let hits = closuresOnRoutes(result.routes, input.closures);
  for (let round = 0; round < MAX_PLANNED_CLOSURE_ROUNDS && hits.size > 0; round++) {
    const added: DirectedExclusion[] = [];
    for (const [id, samples] of hits) {
      const closure = byId.get(id);
      if (!closure || !excludable(closure, input.waypoints)) continue;
      for (const s of samples) {
        if (directed.some((d) => d.point[0] === s.lon && d.point[1] === s.lat)) continue;
        if (ends.some((end) => haversineDistance(end, [s.lon, s.lat]) < END_CLEARANCE_M)) continue;
        added.push({ point: [s.lon, s.lat], heading: s.heading });
      }
      excluded.add(id);
    }
    if (added.length === 0 || directed.length + added.length > MAX_DIRECTED_EXCLUSIONS) break;
    let next: T;
    try {
      next = await input.plan({ ...input.options, directedExclusions: [...directed, ...added] });
    } catch {
      break;
    }
    directed.push(...added);
    result = next;
    hits = closuresOnRoutes(result.routes, input.closures);
  }
  // A local-access road an end lies on is the trip's own way in or out.
  const onRoute = [...hits.keys()].filter((id) => {
    const closure = byId.get(id);
    return closure !== undefined && excludable(closure, input.waypoints);
  });
  return { result, excluded: [...excluded].filter((id) => !hits.has(id)), onRoute };
}

/**
 * The route impact once planned closures have been weighed: a route still
 * travelling one is `limited`; a failed read says so; otherwise the reasons
 * record that the closures in force then were routed around.
 */
export function plannedClosureImpact(
  impact: RoadConditionRouteImpact | undefined,
  outcome:
    | { kind: "unavailable" }
    | { kind: "shadow"; onRoute: number }
    | { kind: "applied"; excluded: number; onRoute: number; unrepresentable: number },
): RoadConditionRouteImpact {
  const base: RoadConditionRouteImpact = impact ?? {
    availability: "unsupported",
    evaluatedAt: new Date().toISOString(),
    validUntil: null,
    reasons: [],
  };
  const reasons = new Set(base.reasons);
  let availability = base.availability;
  if (outcome.kind === "unavailable") {
    reasons.add("planned_closures_unavailable");
  } else if (outcome.kind === "shadow") {
    if (outcome.onRoute > 0) reasons.add("planned_closures_shadow");
  } else {
    if (outcome.excluded > 0) reasons.add("planned_closures_avoided");
    if (outcome.unrepresentable > 0) reasons.add("planned_closures_unrepresentable");
    if (outcome.onRoute > 0) {
      reasons.add("planned_closure_on_route");
      availability = "limited";
    }
  }
  return { ...base, availability, reasons: [...reasons] };
}

export type PlannedClosureOutcomeKind = Parameters<typeof plannedClosureImpact>[1];

/**
 * Weighs the planned closures for a car trip at `travelAt` against `first`
 * and plans again around those it travels. Shadow evidence is evaluated and
 * logged but never excluded. Returns the result to answer with and the
 * outcome its impact reports.
 */
export async function avoidPlannedClosures<T extends { routes: Route[] }>(
  ctx: IntegrationContext,
  input: {
    first: T;
    waypoints: readonly LngLat[];
    travelAt: Date;
    options: RoutingOptions;
    plan: (options: RoutingOptions) => Promise<T>;
  },
): Promise<{ result: T; outcome: PlannedClosureOutcomeKind }> {
  const box = routesBox(input.first.routes);
  if (!box) return { result: input.first, outcome: { kind: "unavailable" } };
  const planned = await readPlannedClosures(ctx, box, input.travelAt);
  if (!planned) return { result: input.first, outcome: { kind: "unavailable" } };
  if (planned.mode !== "active") {
    const onRoute = closuresOnRoutes(input.first.routes, planned.closures).size;
    if (onRoute > 0)
      ctx.log.info(`[routing] shadow: ${onRoute} planned closure(s) on the route, not excluded`);
    return { result: input.first, outcome: { kind: "shadow", onRoute } };
  }
  const { result, excluded, onRoute } = await routeAroundPlannedClosures({
    first: input.first,
    closures: planned.closures,
    waypoints: input.waypoints,
    options: input.options,
    plan: input.plan,
  });
  return {
    result,
    outcome: {
      kind: "applied",
      excluded: excluded.length,
      onRoute: onRoute.length,
      unrepresentable: planned.unrepresentable,
    },
  };
}
