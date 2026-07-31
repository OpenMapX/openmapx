import type { BBox, RouteFlowInput, RouteFlowResponse, RouteFlowSpan } from "@openmapx/core";
import { cumulativeDistances, projectFlowToRoute, routeFingerprint } from "@openmapx/core";
import type { IntegrationContext } from "@openmapx/integration-framework";
import { aggregateRoadFlow } from "./orchestrator.js";

/** Route chunk length for the corridor queries, and the corridor half-width. */
const CHUNK_METERS = 20_000;
const PAD_METERS = 150;
/** A directions result carries at most three alternatives plus the active route. */
const MAX_ROUTES = 4;
const MAX_POINTS_PER_ROUTE = 20_000;
/**
 * Upper bound on corridor chunks per route. Chunk count is otherwise bounded
 * only by point count: a crafted route whose consecutive points are each
 * further apart than `CHUNK_METERS` produces one chunk per point pair, so a
 * `MAX_POINTS_PER_ROUTE`-sized route could fan out to ~20,000 chunks, each
 * firing its own provider fan-out via `aggregateRoadFlow`. 500 chunks ×
 * 20 km ≈ 10,000 km of route — comfortably past any real driving route —
 * while cutting that worst case by 40x.
 */
const MAX_CHUNKS_PER_ROUTE = 500;

/**
 * Padded bounding boxes covering the route in chunks. A single box around a long
 * route would pull in every segment for a whole region; chunking keeps each
 * provider query close to the road actually being driven.
 */
export function routeCorridorBboxes(
  geometry: [number, number][],
  chunkMeters = CHUNK_METERS,
  padMeters = PAD_METERS,
): BBox[] {
  if (geometry.length < 2) return [];
  const cumulative = cumulativeDistances(geometry);
  const boxes: BBox[] = [];
  let start = 0;
  while (start < geometry.length - 1) {
    let end = start;
    while (end < geometry.length - 1 && cumulative[end] - cumulative[start] < chunkMeters) end++;
    let west = Number.POSITIVE_INFINITY;
    let south = Number.POSITIVE_INFINITY;
    let east = Number.NEGATIVE_INFINITY;
    let north = Number.NEGATIVE_INFINITY;
    for (let i = start; i <= end; i++) {
      const [lng, lat] = geometry[i];
      if (lng < west) west = lng;
      if (lng > east) east = lng;
      if (lat < south) south = lat;
      if (lat > north) north = lat;
    }
    // Degrees of longitude shrink with latitude; pad by the widest case in the
    // box so the corridor is at least `padMeters` on every side.
    const latPad = padMeters / 111_320;
    const cosLat = Math.max(
      0.05,
      Math.cos((Math.max(Math.abs(south), Math.abs(north)) * Math.PI) / 180),
    );
    const lngPad = padMeters / (111_320 * cosLat);
    boxes.push([west - lngPad, south - latPad, east + lngPad, north + latPad]);
    start = end;
  }
  return boxes;
}

function isCoordinate(value: unknown): value is [number, number] {
  if (!Array.isArray(value) || value.length < 2) return false;
  const [lng, lat] = value;
  if (typeof lng !== "number" || typeof lat !== "number") return false;
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return false;
  return lng >= -180 && lng <= 180 && lat >= -90 && lat <= 90;
}

/**
 * How many corridor chunks `routeCorridorBboxes` would produce for this
 * route, without allocating any of the boxes themselves — used purely to
 * reject an oversized route during validation, before its geometry is used
 * for anything that costs a provider fan-out.
 */
function countRouteChunks(geometry: [number, number][], chunkMeters = CHUNK_METERS): number {
  if (geometry.length < 2) return 0;
  const cumulative = cumulativeDistances(geometry);
  let count = 0;
  let start = 0;
  while (start < geometry.length - 1) {
    let end = start;
    while (end < geometry.length - 1 && cumulative[end] - cumulative[start] < chunkMeters) end++;
    count++;
    start = end;
  }
  return count;
}

/** Validate the request body, rejecting rather than silently clamping. */
export function parseRouteFlowBody(body: unknown): RouteFlowInput[] | null {
  if (!body || typeof body !== "object") return null;
  const routes = (body as { routes?: unknown }).routes;
  if (!Array.isArray(routes) || routes.length === 0 || routes.length > MAX_ROUTES) return null;
  const out: RouteFlowInput[] = [];
  for (const raw of routes) {
    if (!raw || typeof raw !== "object") return null;
    const { id, geometry } = raw as { id?: unknown; geometry?: unknown };
    if (typeof id !== "string" || id.length === 0 || id.length > 64) return null;
    if (!Array.isArray(geometry) || geometry.length < 2) return null;
    if (geometry.length > MAX_POINTS_PER_ROUTE) return null;
    if (!geometry.every(isCoordinate)) return null;
    const typedGeometry = geometry as [number, number][];
    if (countRouteChunks(typedGeometry) > MAX_CHUNKS_PER_ROUTE) return null;
    out.push({ id, geometry: typedGeometry });
  }
  return out;
}

/**
 * Live flow along each submitted route. Free-flow and unknown stretches are
 * dropped before serialising: nothing renders for them, so sending them would
 * be most of the payload for none of the picture.
 *
 * Each route gets its own try/catch: `aggregateRoadFlow` already isolates a
 * provider throwing, but a route can still fail for reasons that have
 * nothing to do with providers (a cache backend error, a bug in matching
 * that only one route's geometry triggers). Without a per-route boundary,
 * one such failure would reject the shared `Promise.all` and blank every
 * route in the request, not just the one that failed.
 */
export async function flowSpansForRoutes(
  ctx: IntegrationContext,
  routes: RouteFlowInput[],
): Promise<RouteFlowResponse> {
  const results = await Promise.all(
    routes.map(async (route) => {
      try {
        const key = `conditions:query:flowroute:${routeFingerprint(route.geometry)}`;
        const spans = await ctx.cache.withCache<RouteFlowSpan[]>(key, 60, async () => {
          const boxes = routeCorridorBboxes(route.geometry);
          const perBox = await Promise.all(boxes.map((box) => aggregateRoadFlow(ctx, box)));
          const seen = new Set<string>();
          const segments = perBox.flat().filter((segment) => {
            const id = `${segment.provider}:${segment.id}:${segment.direction}`;
            if (seen.has(id)) return false;
            seen.add(id);
            return true;
          });
          return projectFlowToRoute(segments, route.geometry).filter(
            (span) => span.los !== "free_flow" && span.los !== "unknown",
          );
        });
        return { id: route.id, spans };
      } catch (err) {
        ctx.log.error(`road-conditions route flow failed for route ${route.id}`, err);
        return { id: route.id, spans: [] };
      }
    }),
  );
  return { routes: results };
}
