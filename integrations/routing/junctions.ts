import {
  angularDifference,
  bearingBetween,
  haversineDistance,
  type JunctionLookupPoint,
  type JunctionLookupResult,
  type JunctionWay,
  type LngLat,
  type OsmLaneTags,
} from "@openmapx/core";
import { parseWgs84Point, parseWgs84PointList } from "@openmapx/integration-framework";
import { hashKey, round } from "./closure-exclusions.js";

/**
 * `POST /navigation/junctions` — the per-lane gantry data behind the junction
 * view. All uncached decision points of a request share one Overpass query
 * (one polyline `around` statement per point over its route trace, never a fan
 * of extrapolated circles); the merged result is handed back out per point by
 * proximity to that point's trace. Cached per point for a week.
 */

/** Bounds of the request body. */
const MAX_POINTS = 40;
const MIN_TRACE_VERTICES = 2;
const MAX_TRACE_VERTICES = 8;

/** Spatial radius of each Overpass `around` statement, metres. */
const AROUND_RADIUS_METERS = 20;
/**
 * A way from the shared result belongs to a point when one of its nodes lies
 * within this of the point's trace. Wider than the `around` radius so a way
 * matched by its segment passing between two trace vertices still qualifies.
 */
const TRACE_MATCH_METERS = 60;
/** Approach ways must head the route's way and end at most this far upstream. */
const APPROACH_BEARING_TOLERANCE_DEG = 35;
const APPROACH_MAX_UPSTREAM_METERS = 450;
/** Below this the way end sits on the decision point and its side is moot. */
const END_ON_POINT_METERS = 5;
/**
 * A carriageway within this of the decision point is the road the route is
 * on. The route shape follows OSM's own centreline, so the real road passes
 * within a few metres; the neighbouring carriageway of a dual road lies
 * further out and runs the other way.
 */
const ON_CARRIAGEWAY_METERS = 10;
/** Keys that make a way worth drawing as a gantry or exit panel. */
const GANTRY_TAG = /^(destination|turn)(:|$)/;

export const JUNCTION_CACHE_TTL_SECONDS = 7 * 86_400;

/** Parse the request body; `null` means a 400. */
export function parseJunctionPoints(body: unknown): JunctionLookupPoint[] | null {
  if (!body || typeof body !== "object") return null;
  const raw = (body as { points?: unknown }).points;
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_POINTS) return null;
  const points: JunctionLookupPoint[] = [];
  for (const candidate of raw) {
    if (!candidate || typeof candidate !== "object") return null;
    const entry = candidate as { lng?: unknown; lat?: unknown; bearing?: unknown; trace?: unknown };
    const centre = parseWgs84Point(entry.lng, entry.lat);
    if (!centre) return null;
    if (
      typeof entry.bearing !== "number" ||
      !Number.isFinite(entry.bearing) ||
      entry.bearing < 0 ||
      entry.bearing >= 360
    ) {
      return null;
    }
    const trace = parseWgs84PointList(entry.trace, {
      min: MIN_TRACE_VERTICES,
      max: MAX_TRACE_VERTICES,
    });
    if (!trace) return null;
    points.push({
      lng: centre[0],
      lat: centre[1],
      bearing: entry.bearing,
      trace: trace.map(([lng, lat]) => [lng, lat] as LngLat),
    });
  }
  return points;
}

/** The per-point cache key: position to ~10 m, bearing to 10°. */
export function junctionCacheKey(point: JunctionLookupPoint): string {
  return hashKey("cache:nav:junction-ways", [
    round(point.lng, 4),
    round(point.lat, 4),
    round(point.bearing / 10, 0) * 10,
  ]);
}

/**
 * One Overpass statement per point, joined into the single shared query. Ways
 * come back whether or not they carry destination tags: an untagged
 * carriageway through the split is still the evidence that the route is on a
 * motorway there.
 */
export function buildJunctionsQuery(points: JunctionLookupPoint[]): string {
  const statements = points
    .map(
      (point) =>
        `way(around:${AROUND_RADIUS_METERS},${point.trace
          .map(([lng, lat]) => `${lat},${lng}`)
          .join(",")})["highway"~"^(motorway|trunk|motorway_link|trunk_link)$"];`,
    )
    .join("");
  return `[out:json][timeout:25];(${statements});out tags geom;`;
}

export interface OverpassWayElement {
  type: string;
  id: number;
  tags?: Record<string, string>;
  geometry?: { lat: number; lon: number }[];
}

/** Tags the route reads off an approach or ramp way. */
function laneTags(tags: Record<string, string>): OsmLaneTags {
  const lanes = Number(tags.lanes);
  return {
    ...(Number.isFinite(lanes) && lanes > 0 ? { lanes: Math.round(lanes) } : {}),
    ...(tags["turn:lanes"] ? { turnLanes: tags["turn:lanes"] } : {}),
    ...(tags["destination:lanes"] ? { destinationLanes: tags["destination:lanes"] } : {}),
    ...(tags["destination:ref:lanes"]
      ? { destinationRefLanes: tags["destination:ref:lanes"] }
      : {}),
    ...(tags["destination:symbol:lanes"]
      ? { destinationSymbolLanes: tags["destination:symbol:lanes"] }
      : {}),
    ...(tags["destination:colour:lanes"]
      ? { destinationColourLanes: tags["destination:colour:lanes"] }
      : {}),
    ...(tags.destination ? { destination: tags.destination } : {}),
    ...(tags["destination:ref"] ? { destinationRef: tags["destination:ref"] } : {}),
    ...(tags["destination:symbol"] ? { destinationSymbol: tags["destination:symbol"] } : {}),
    ...(tags["destination:int_ref"] ? { destinationInt: tags["destination:int_ref"] } : {}),
    ...(tags["junction:ref"] ? { junctionRef: tags["junction:ref"] } : {}),
  };
}

/** Metres from `node` to the nearest point on the polyline, in a local planar frame. */
function distanceToPolyline(node: LngLat, polyline: LngLat[]): number {
  const metresPerDegLng = 111_320 * Math.cos((node[1] * Math.PI) / 180);
  const toLocal = ([lng, lat]: LngLat): [number, number] => [
    (lng - node[0]) * metresPerDegLng,
    (lat - node[1]) * 111_320,
  ];
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < polyline.length - 1; i += 1) {
    const [ax, ay] = toLocal(polyline[i]);
    const [bx, by] = toLocal(polyline[i + 1]);
    const dx = bx - ax;
    const dy = by - ay;
    const lengthSq = dx * dx + dy * dy;
    // The node is the local origin, so the projection parameter is of (0, 0).
    const t = lengthSq === 0 ? 0 : Math.min(Math.max(-(ax * dx + ay * dy) / lengthSq, 0), 1);
    best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
  }
  return best;
}

/** Map one Overpass way to a `JunctionWay`, or null when it has no usable geometry. */
function mapWay(element: OverpassWayElement, point: JunctionLookupPoint): JunctionWay | null {
  if (!element.geometry || element.geometry.length < 2) return null;
  const tags = element.tags ?? {};
  // Everything below runs in travel order; oneway=-1 ways are drawn against it.
  const nodes = element.geometry.map((node) => [node.lon, node.lat] as LngLat);
  if (tags.oneway === "-1") nodes.reverse();
  const centre: LngLat = [point.lng, point.lat];

  // The bearing is read at the node nearest the decision point, from the
  // segment leaving it (or arriving at it, at the way's end): a ramp curves
  // away within a few nodes, so its far end says nothing about the split.
  let nearest = 0;
  for (let i = 1; i < nodes.length; i += 1) {
    if (haversineDistance(nodes[i], centre) < haversineDistance(nodes[nearest], centre))
      nearest = i;
  }
  const bearing =
    nearest === nodes.length - 1
      ? bearingBetween(nodes[nearest - 1], nodes[nearest])
      : bearingBetween(nodes[nearest], nodes[nearest + 1]);

  // Signed distance of the way's travel end: positive when the way leads into
  // the point (its end lies upstream of it), negative when it runs away from it.
  const end = nodes[nodes.length - 1];
  const endDistance = haversineDistance(end, centre);
  const endBearing = bearingBetween(nodes[nodes.length - 2], end);
  const leadsIn =
    endDistance < END_ON_POINT_METERS ||
    angularDifference(bearingBetween(end, centre), endBearing) <= 90;

  return {
    wayId: element.id,
    highway: tags.highway ?? "",
    ...(tags.ref ? { ref: tags.ref } : {}),
    ...(tags.name ? { name: tags.name } : {}),
    bearing,
    endDistanceMeters: leadsIn ? endDistance : -endDistance,
    startDistanceMeters: haversineDistance(nodes[0], centre),
    tags: laneTags(tags),
  };
}

/**
 * The approach ways and ramps of one point from the shared Overpass result.
 * Ways matched by another point's statement are dropped by their distance to
 * this point's trace; the bearing filter then tells the parallel carriageway
 * from the searched one where the 20 m spatial window cannot.
 */
export function mapJunctionWays(
  elements: OverpassWayElement[],
  point: JunctionLookupPoint,
): Omit<JunctionLookupResult, "index"> {
  const centre: LngLat = [point.lng, point.lat];
  const matched = elements.flatMap((element) => {
    if (element.type !== "way" || !element.geometry) return [];
    const nearTrace = element.geometry.some(
      (node) => distanceToPolyline([node.lon, node.lat], point.trace) <= TRACE_MATCH_METERS,
    );
    if (!nearTrace) return [];
    const way = mapWay(element, point);
    if (!way) return [];
    const tagged = Object.keys(element.tags ?? {}).some((key) => GANTRY_TAG.test(key));
    const nodes = element.geometry.map((node) => [node.lon, node.lat] as LngLat);
    if (element.tags?.oneway === "-1") nodes.reverse();
    return [{ way, tagged, nodes, pointDistance: distanceToPolyline(centre, nodes) }];
  });
  const carriageways = matched.filter(
    ({ way, pointDistance }) =>
      !way.highway.includes("_link") &&
      pointDistance <= ON_CARRIAGEWAY_METERS &&
      angularDifference(way.bearing, point.bearing) <= APPROACH_BEARING_TOLERANCE_DEG,
  );
  const onMotorway = carriageways.length > 0;
  const fullLanesFromMeters = fullLanesFrom(matched, carriageways, point);
  const drawable = matched.filter((entry) => entry.tagged).map((entry) => entry.way);
  const approach = drawable.filter(
    (way) =>
      !way.highway.includes("_link") &&
      angularDifference(way.bearing, point.bearing) <= APPROACH_BEARING_TOLERANCE_DEG &&
      way.endDistanceMeters >= 0 &&
      way.endDistanceMeters <= APPROACH_MAX_UPSTREAM_METERS,
  );
  const ramps = drawable.filter((way) => way.highway.includes("_link"));
  return {
    approach,
    ramps,
    onMotorway,
    ...(fullLanesFromMeters !== undefined ? { fullLanesFromMeters } : {}),
  };
}

interface MatchedWay {
  way: JunctionWay;
  nodes: LngLat[];
}

/**
 * Metres before the decision point from which the carriageway already has the
 * lane count it has at the split. OSM splits a way wherever `lanes` changes,
 * so the chain of upstream ways keeping at least that many lanes ends where
 * the exit lanes were added. Walked node to node rather than read off the one
 * way at the split, which is often cut short by a bridge or a sign change.
 */
function fullLanesFrom(
  matched: MatchedWay[],
  carriageways: MatchedWay[],
  point: JunctionLookupPoint,
): number | undefined {
  const centre: LngLat = [point.lng, point.lat];
  // The way carrying the route into the split, not one starting at it.
  const atSplit = carriageways
    .filter(({ way }) => way.startDistanceMeters > END_ON_POINT_METERS)
    .sort((a, b) => Math.abs(a.way.endDistanceMeters) - Math.abs(b.way.endDistanceMeters))[0];
  const lanes = atSplit?.way.tags.lanes;
  if (!atSplit || lanes === undefined) return undefined;
  let current = atSplit;
  const visited = new Set([current.way.wayId]);
  for (;;) {
    const start = current.nodes[0];
    const upstream = matched.find(
      (entry) =>
        !visited.has(entry.way.wayId) &&
        !entry.way.highway.includes("_link") &&
        (entry.way.tags.lanes ?? 0) >= lanes &&
        // A motorway merging in at that node is not this carriageway.
        angularDifference(entry.way.bearing, current.way.bearing) <=
          APPROACH_BEARING_TOLERANCE_DEG &&
        haversineDistance(entry.nodes[entry.nodes.length - 1], start) < 1,
    );
    if (!upstream) break;
    visited.add(upstream.way.wayId);
    current = upstream;
  }
  return Math.round(haversineDistance(current.nodes[0], centre));
}
