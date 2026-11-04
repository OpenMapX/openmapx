import type { RawRoadAlert, RoadAlertRoad } from "../api/roadAlerts";
import type { LngLat } from "../types/geometry";
import { haversineDistance } from "../utils/coordinates";
import type { RoadAlert } from "./alerts";

/**
 * Attaching approach alerts (stop signs, level crossings, speed bumps, speed
 * cameras) to the route by the roads they sit on.
 *
 * Being near the route is not enough: a stop sign on a side street stands a
 * few metres from the priority road, and a speed bump on a parallel street or
 * one passing below a bridge can be just as close. An alert belongs to the
 * route only when the route *arrives along* one of the alert's roads — it
 * passes the alert's position, and the road behind that position, in the
 * direction of travel, lies on the route just before it — and the road says the
 * alert applies to traffic travelling that way.
 *
 * Route geometry from the routing engines is made of the same OpenStreetMap
 * node coordinates as the roads, so the match can be tight; the tolerance
 * covers coordinate rounding and small edits between the routing graph's and
 * the alert source's OSM snapshots.
 */

/** Largest gap between a road (or alert position) and the route, metres. */
export const ROAD_ALERT_ON_ROUTE_M = 3;
/**
 * Distances behind the alert, along its road, that must lie on the route
 * before the alert. The far one rejects a road converging on the route at a
 * shallow angle; the server sends a little more road than this.
 */
const APPROACH_SAMPLES_M = [5, 15, 30] as const;
/** Less road than this behind the alert is no evidence of arriving along it. */
const MIN_APPROACH_M = 2;
/** Positions closer than this along the route are one pass of the route. */
const SAME_PASS_M = 10;

/** The part of the route, in along-route metres, whose alerts are wanted. */
export interface AlongRange {
  fromMeters: number;
  toMeters: number;
}

const METERS_PER_DEGREE_LAT = 110_574;
const METERS_PER_DEGREE_LNG_EQUATOR = 111_320;

interface Frame {
  origin: LngLat;
  kx: number;
}

function frameAt(origin: LngLat): Frame {
  return { origin, kx: Math.cos((origin[1] * Math.PI) / 180) * METERS_PER_DEGREE_LNG_EQUATOR };
}

function toLocal(frame: Frame, point: LngLat): [number, number] {
  return [
    (point[0] - frame.origin[0]) * frame.kx,
    (point[1] - frame.origin[1]) * METERS_PER_DEGREE_LAT,
  ];
}

/** First segment index whose end is at or past `along`. */
function segmentAt(cum: number[], along: number): number {
  let lo = 0;
  let hi = cum.length - 2;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cum[mid + 1] < along) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Closest approach of the route, restricted to along-route metres
 * `[lo, hi]`, to `frame.origin`; calls `visit` once per segment.
 */
function scanRoute(
  geometry: LngLat[],
  cum: number[],
  lo: number,
  hi: number,
  frame: Frame,
  visit: (distance: number, along: number) => void,
): void {
  if (geometry.length < 2 || hi < lo) return;
  const total = cum[cum.length - 1];
  const from = Math.max(0, lo);
  const to = Math.min(total, hi);
  if (to < from) return;
  for (let i = segmentAt(cum, from); i < geometry.length - 1 && cum[i] <= to; i++) {
    const length = cum[i + 1] - cum[i];
    const [ax, ay] = toLocal(frame, geometry[i]);
    const [bx, by] = toLocal(frame, geometry[i + 1]);
    const dx = bx - ax;
    const dy = by - ay;
    const lengthSquared = dx * dx + dy * dy;
    const tMin = length > 0 ? Math.max(0, (from - cum[i]) / length) : 0;
    const tMax = length > 0 ? Math.min(1, (to - cum[i]) / length) : 0;
    const t =
      lengthSquared > 0
        ? Math.min(tMax, Math.max(tMin, -(ax * dx + ay * dy) / lengthSquared))
        : tMin;
    visit(Math.hypot(ax + t * dx, ay + t * dy), cum[i] + t * length);
  }
}

/** Along-route positions where the route passes within tolerance of `point`. */
function passesBy(geometry: LngLat[], cum: number[], range: AlongRange, point: LngLat): number[] {
  const near: { along: number; distance: number }[] = [];
  scanRoute(geometry, cum, range.fromMeters, range.toMeters, frameAt(point), (distance, along) => {
    if (distance <= ROAD_ALERT_ON_ROUTE_M) near.push({ along, distance });
  });
  near.sort((a, b) => a.along - b.along);
  const passes: { along: number; distance: number }[] = [];
  for (const candidate of near) {
    const last = passes[passes.length - 1];
    if (last && candidate.along - last.along <= SAME_PASS_M) {
      if (candidate.distance < last.distance) passes[passes.length - 1] = candidate;
    } else {
      passes.push(candidate);
    }
  }
  return passes.map((pass) => pass.along);
}

/**
 * The point `distance` metres from the anchor along `road.line`, walking
 * toward lower indices (`step` -1) or higher ones (+1); null past the slice.
 */
function pointBehind(road: RoadAlertRoad, step: 1 | -1, distance: number): LngLat | null {
  let travelled = 0;
  for (let i = road.anchorIndex; i + step >= 0 && i + step < road.line.length; i += step) {
    const a = road.line[i];
    const b = road.line[i + step];
    const length = haversineDistance(a, b);
    if (travelled + length >= distance) {
      const t = length > 0 ? (distance - travelled) / length : 0;
      return [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
    }
    travelled += length;
  }
  return null;
}

/** Length of `road.line` from the anchor to its end in the `step` direction. */
function lengthBehind(road: RoadAlertRoad, step: 1 | -1): number {
  let length = 0;
  for (let i = road.anchorIndex; i + step >= 0 && i + step < road.line.length; i += step) {
    length += haversineDistance(road.line[i], road.line[i + step]);
  }
  return length;
}

/**
 * Whether the route, passing the anchor at `along`, arrives there along
 * `road`: forward traffic comes from the slice's lower indices, backward from
 * its higher ones. Road behind the route's start cannot be checked and does
 * not count against it.
 */
function arrivesAlong(
  road: RoadAlertRoad,
  forward: boolean,
  along: number,
  geometry: LngLat[],
  cum: number[],
): boolean {
  const step = forward ? -1 : 1;
  const available = lengthBehind(road, step);
  if (available < MIN_APPROACH_M || along < MIN_APPROACH_M) return false;
  const distances = [...new Set(APPROACH_SAMPLES_M.map((d) => Math.min(d, available)))];
  for (const distance of distances) {
    if (distance > along + ROAD_ALERT_ON_ROUTE_M) break;
    const sample = pointBehind(road, step, distance);
    if (!sample) return false;
    let closest = Number.POSITIVE_INFINITY;
    scanRoute(geometry, cum, along - 1.5 * distance - 5, along, frameAt(sample), (gap) => {
      if (gap < closest) closest = gap;
    });
    if (closest > ROAD_ALERT_ON_ROUTE_M) return false;
  }
  return true;
}

/**
 * Attach approach alerts to the route where it arrives at them along one of
 * their roads in a direction they apply to. Only route passes inside `range`
 * count; `cum` is `cumulativeDistances(geometry)`. An alert met on several
 * passes of the route (a loop, an out-and-back) yields one alert per pass: the
 * first keeps the alert's id, later ones get `#1`, `#2`, ….
 */
export function projectRoadAlertsOntoRoute(
  alerts: readonly RawRoadAlert[],
  geometry: LngLat[],
  cum: number[],
  range: AlongRange,
): RoadAlert[] {
  const out: RoadAlert[] = [];
  for (const alert of alerts) {
    const accepted: { along: number; coord: LngLat }[] = [];
    for (const road of alert.roads) {
      const anchor = road.line[road.anchorIndex];
      if (!anchor) continue;
      for (const along of passesBy(geometry, cum, range, anchor)) {
        const applies =
          (road.forward && arrivesAlong(road, true, along, geometry, cum)) ||
          (road.backward && arrivesAlong(road, false, along, geometry, cum));
        if (applies) accepted.push({ along, coord: anchor });
      }
    }
    accepted.sort((a, b) => a.along - b.along);
    let previous = Number.NEGATIVE_INFINITY;
    let pass = 0;
    for (const { along, coord } of accepted) {
      if (along - previous <= SAME_PASS_M) continue;
      previous = along;
      out.push({
        id: pass === 0 ? alert.id : `${alert.id}#${pass}`,
        type: alert.type,
        coord,
        alongMeters: along,
        ...(alert.speedLimitKmh !== undefined ? { speedLimitKmh: alert.speedLimitKmh } : {}),
      });
      pass++;
    }
  }
  return out;
}
