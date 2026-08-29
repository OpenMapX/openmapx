import type { BBox } from "@openmapx/core";
import { type IntegrationContext, scalarQueries } from "@openmapx/integration-framework";
import { eventsToFeatureCollection } from "./eventsToGeojson.js";
import { flowSpansForRoutes, parseRouteFlowBody } from "./flowAlongRoute.js";
import { flowToFeatureCollection } from "./flowToGeojson.js";
import { aggregateRoadConditions, aggregateRoadFlow } from "./orchestrator.js";
import type { RoadConditionSeverity, RoadConditionType } from "./types.js";

/**
 * Parse a `west,south,east,north` query param into a BBox, rejecting malformed
 * or out-of-domain input rather than silently substituting a wrong value.
 *
 * NOTE: this is a byte-identical copy of `parseBbox` in OpenConditions'
 * `services/ingest/src/publish-routes.ts` — there is no shared package either
 * side imports from, so any future change here must be mirrored there too.
 */
export function parseBbox(raw: string | undefined): BBox | null {
  if (!raw) return null;
  const segments = raw.split(",");
  // Reject blank segments explicitly — `Number("")` is `0` (finite), so
  // "1,,3,4" would otherwise silently parse to [1, 0, 3, 4] instead of
  // being rejected as malformed.
  if (segments.length !== 4 || segments.some((s) => s.trim() === "")) return null;
  const parts = segments.map(Number);
  if (parts.some((n) => !Number.isFinite(n))) return null;
  const [west, south, east, north] = parts as BBox;
  if (west < -180 || west > 180 || east < -180 || east > 180) return null;
  if (south < -90 || south > 90 || north < -90 || north > 90) return null;
  if (south > north) return null;
  // west > east would describe an antimeridian-crossing box; those are not
  // supported downstream (bbox intersection assumes west <= east), so reject
  // rather than silently returning empty/wrong results.
  if (west > east) return null;
  return parts as BBox;
}

function bboxKey(bbox: BBox): string {
  return bbox.map((n) => n.toFixed(4)).join(",");
}

/**
 * `?horizonDays=7` → "in effect within a week"; `0` → "active now". Anything
 * that isn't a non-negative integer reads as absent (no temporal filter), never
 * as `0` — a typo must not silently hide every upcoming closure.
 */
function parseHorizonDays(raw: string | undefined): number | undefined {
  if (raw == null || raw.trim() === "") return undefined;
  if (!/^\d+$/.test(raw.trim())) return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isSafeInteger(n) ? n : undefined;
}

export function setup(ctx: IntegrationContext): void {
  // GET /events?bbox=west,south,east,north[&types=&minSeverity=&horizonDays=]
  // Aggregates every enabled road-conditions provider into one GeoJSON
  // FeatureCollection — consumed by both the map overlay and navigation.
  ctx.registerRoute("GET", "/events", async (req, reply) => {
    const bbox = parseBbox(scalarQueries(req.query).bbox);
    if (!bbox) {
      reply.status(400).send({ error: "bbox required: west,south,east,north" });
      return;
    }

    const types = (scalarQueries(req.query).types ?? "")
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean) as RoadConditionType[];
    const minSeverity = (scalarQueries(req.query).minSeverity || undefined) as
      | RoadConditionSeverity
      | undefined;
    const horizonDays = parseHorizonDays(scalarQueries(req.query).horizonDays);

    const key = `conditions:query:roads:${bboxKey(bbox)}:${types.join("+")}:${minSeverity ?? ""}:${horizonDays ?? ""}`;

    try {
      const fc = await ctx.cache.withCache(key, 90, async () => {
        const events = await aggregateRoadConditions(ctx, bbox, {
          types: types.length > 0 ? types : undefined,
          minSeverity,
          horizonDays,
        });
        return eventsToFeatureCollection(events);
      });
      reply.header("Cache-Control", "public, max-age=90, s-maxage=90");
      reply.send(fc);
    } catch (err) {
      // A total aggregation failure (every provider threw, or a step outside
      // `Promise.allSettled` — dedupe, the disallowed-source lookup — threw)
      // must not read as "no closures on this road": navigation arms its
      // closure baseline off this response, and an empty 200 here would let
      // it treat pre-existing closures as newly appeared once the aggregator
      // recovers. Partial provider failure never reaches this catch —
      // `aggregateRoadConditions` tolerates that internally and still
      // resolves with whatever providers did succeed.
      ctx.log.error("road-conditions aggregation failed", err);
      reply.header("Cache-Control", "no-cache");
      reply.status(503).send({ error: "road-conditions aggregation failed" });
    }
  });

  // GET /flow?bbox=west,south,east,north
  // Non-tile fallback: aggregates every provider's live speed/congestion
  // segments into one GeoJSON FeatureCollection — the Martin vector tiles
  // (Task 2) are the primary path, this route backs providers/consumers
  // that can't speak MVT.
  ctx.registerRoute("GET", "/flow", async (req, reply) => {
    const bbox = parseBbox(scalarQueries(req.query).bbox);
    if (!bbox) {
      reply.status(400).send({ error: "bbox required: west,south,east,north" });
      return;
    }

    const key = `conditions:query:flow:${bboxKey(bbox)}`;

    try {
      const fc = await ctx.cache.withCache(key, 60, async () => {
        const segments = await aggregateRoadFlow(ctx, bbox);
        return flowToFeatureCollection(segments);
      });
      reply.header("Cache-Control", "public, max-age=60");
      reply.send(fc);
    } catch (err) {
      ctx.log.error("road-conditions flow aggregation failed", err);
      reply.header("Cache-Control", "no-cache");
      reply.send({ type: "FeatureCollection", features: [] });
    }
  });

  // POST /flow-along-route { routes: [{ id, geometry }] }
  // Live speed/congestion matched onto each submitted route polyline and
  // returned as along-route metre spans, so the client can paint the route
  // itself instead of the road segments beside it. POST because a long route's
  // geometry is far past any URL length limit.
  ctx.registerRoute("POST", "/flow-along-route", async (req, reply) => {
    const routes = parseRouteFlowBody(req.body);
    if (!routes) {
      reply.status(400).send({ error: "routes required: [{ id, geometry: [[lng,lat], …] }]" });
      return;
    }
    try {
      const result = await flowSpansForRoutes(ctx, routes);
      reply.header("Cache-Control", "no-store");
      reply.send(result);
    } catch (err) {
      ctx.log.error("road-conditions route flow failed", err);
      reply.header("Cache-Control", "no-cache");
      reply.send({ routes: routes.map((r) => ({ id: r.id, spans: [] })) });
    }
  });
}
