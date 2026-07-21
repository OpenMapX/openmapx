import { createHash } from "node:crypto";
import { timeZoneAt } from "@openmapx/core";
import type { IntegrationContext } from "@openmapx/integration-framework";
import { activeClosuresForBbox } from "./closures.js";
import { zonedWallClockToInstant } from "./timezone.js";

/**
 * Resolve the travel instant for closure-time evaluation: the chosen
 * departAt/arriveBy — a wall-clock "YYYY-MM-DDTHH:mm" local to the route ORIGIN —
 * turned into an absolute instant via the origin's timezone. Returns undefined
 * for "leave now" (closures are then evaluated at the current instant). Falls
 * back to a naive parse if the origin zone can't be resolved.
 */
export function resolveTravelInstant(
  waypoints: [number, number][],
  departAt: string | undefined,
  arriveBy: string | undefined,
): Date | undefined {
  const wall = departAt ?? arriveBy;
  if (!wall) return undefined;
  const origin = waypoints[0];
  const tz = origin ? timeZoneAt(origin[1], origin[0]) : null;
  return (tz ? zonedWallClockToInstant(tz, wall) : null) ?? new Date(wall);
}

/** Round a number to a fixed number of decimal places. */
export function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/** Build a short hash key from a prefix + arbitrary data. */
export function hashKey(prefix: string, data: unknown): string {
  const hash = createHash("sha256").update(JSON.stringify(data)).digest("hex").slice(0, 16);
  return `${prefix}:${hash}`;
}

/** Margin (degrees) added around the waypoint bounding box when querying closures. */
const CLOSURE_BBOX_MARGIN_DEG = 0.05;

export interface ClosureExclusionResult {
  exclusions: { points: [number, number][]; polygons: [number, number][][] };
  hasExclusions: boolean;
  exclusionsHash: string | null;
}

/**
 * Fetch active road closures for the bounding box around the given waypoints
 * and return the exclusion geometry plus a cache-key hash. When
 * `wantClosureAvoidance` is false the function returns empty exclusions
 * immediately without hitting any provider.
 */
export async function applyClosureExclusions(
  ctx: IntegrationContext,
  waypoints: [number, number][],
  wantClosureAvoidance: boolean,
  at?: Date,
): Promise<ClosureExclusionResult> {
  const empty = { points: [] as [number, number][], polygons: [] as [number, number][][] };
  if (!wantClosureAvoidance) {
    return { exclusions: empty, hasExclusions: false, exclusionsHash: null };
  }

  const lons = waypoints.map((wp) => wp[0]);
  const lats = waypoints.map((wp) => wp[1]);
  const bbox: [number, number, number, number] = [
    Math.min(...lons) - CLOSURE_BBOX_MARGIN_DEG,
    Math.min(...lats) - CLOSURE_BBOX_MARGIN_DEG,
    Math.max(...lons) + CLOSURE_BBOX_MARGIN_DEG,
    Math.max(...lats) + CLOSURE_BBOX_MARGIN_DEG,
  ];

  let exclusions = empty;
  try {
    exclusions = await activeClosuresForBbox(ctx, bbox, at);
  } catch (err) {
    ctx.log.warn("[routing] failed to fetch closures; routing without exclusions", err as Error);
  }

  const hasExclusions = exclusions.points.length > 0 || exclusions.polygons.length > 0;
  const exclusionsHash = hasExclusions
    ? hashKey("excl", { points: exclusions.points, polygons: exclusions.polygons })
    : null;

  return { exclusions, hasExclusions, exclusionsHash };
}
