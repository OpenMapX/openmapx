import type { BBox, RoadConditionBindingDetail } from "@openmapx/core";
import { type IntegrationContext, scalarQueries } from "@openmapx/integration-framework";
import { eventsToFeatureCollection } from "./eventsToGeojson.js";
import { flowSpansForRoutes, parseRouteFlowBody } from "./flowAlongRoute.js";
import { flowToFeatureCollection } from "./flowToGeojson.js";
import { aggregateRoadConditions, aggregateRoadFlow, collectProviders } from "./orchestrator.js";
import { isSeverityLabel } from "./severity.js";

/**
 * Lifetime of a cached road-situation response. The client evaluates each
 * effect's state and each situation's expiry at the instant it shows them,
 * so the cache only bounds how late a changed situation can arrive.
 */
const ROAD_EVENT_CACHE_MAX_AGE_S = 60;

/**
 * The situation ids `/bindings` reads: OpenConditions situations, whose
 * record API serves bindings. Any other id is refused before it can reach a
 * provider's request path.
 */
const BINDABLE_SITUATION_ID = /^oc:situation:[^/\\?#]+$/;

/** What `/bindings` caches for a situation without bindings: a cache keeps no bare null. */
const NO_BINDINGS = { none: true } as const;

/** A comma-separated query list, trimmed, empties dropped, sorted for a stable cache key. */
function listParam(raw: string | undefined): string[] {
  return [
    ...new Set(
      (raw ?? "")
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean),
    ),
  ].sort();
}

/**
 * Parse a `west,south,east,north` query param into a BBox, rejecting malformed
 * or out-of-domain input rather than silently substituting a wrong value.
 *
 * NOTE: this is a byte-identical copy of `parseBbox` in OpenConditions'
 * `services/ingest/src/api/query.ts` — there is no shared package either
 * side imports from, so any future change here must be mirrored there too.
 */
export function parseBbox(raw: string | undefined): BBox | null {
  if (typeof raw !== "string" || !raw) return null;
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
  // GET /events?bbox=west,south,east,north[&kinds=&excludeKinds=&types=&minSeverity=&horizonDays=]
  // Aggregates every enabled road-conditions provider into one GeoJSON
  // FeatureCollection — consumed by both the map overlay and navigation.
  // `kinds` are registry kinds to keep, `excludeKinds` registry kinds to leave
  // out and `types` bare registry type codes, AND-ed as OpenConditions
  // filters them; `minSeverity` is a severity label, and an unknown label
  // reads as no threshold.
  ctx.registerRoute("GET", "/events", async (req, reply) => {
    const query = scalarQueries(req.query);
    const bbox = parseBbox(query.bbox);
    if (!bbox) {
      reply.status(400).send({ error: "bbox required: west,south,east,north" });
      return;
    }

    const kinds = listParam(query.kinds);
    const excludeKinds = listParam(query.excludeKinds);
    const types = listParam(query.types);
    const minSeverity = isSeverityLabel(query.minSeverity) ? query.minSeverity : undefined;
    const horizonDays = parseHorizonDays(query.horizonDays);

    // No configured source is not "no incidents": an empty 200 would let the
    // map legend and navigation's closure baseline read the road as clear.
    // Providers that exist but do not cover this bbox do mean an empty answer.
    if (collectProviders(ctx).length === 0) {
      reply.header("Cache-Control", "no-cache");
      reply.status(503).send({ error: "no road-conditions source is configured" });
      return;
    }

    // Namespaced by the contract version: a cache entry written in an older
    // shape must not be served against the new one.
    const key = `conditions:query:roads:situations-contributors-v3:${bboxKey(bbox)}:${kinds.join("+")}:${excludeKinds.join("+")}:${types.join("+")}:${minSeverity ?? ""}:${horizonDays ?? ""}`;

    try {
      const fc = await ctx.cache.withCache(key, ROAD_EVENT_CACHE_MAX_AGE_S, async () => {
        const events = await aggregateRoadConditions(ctx, bbox, {
          ...(kinds.length > 0 ? { kinds } : {}),
          ...(excludeKinds.length > 0 ? { excludeKinds } : {}),
          ...(types.length > 0 ? { types } : {}),
          ...(minSeverity ? { minSeverity } : {}),
          ...(horizonDays !== undefined ? { horizonDays } : {}),
        });
        return eventsToFeatureCollection(events);
      });
      reply.header(
        "Cache-Control",
        `public, max-age=${ROAD_EVENT_CACHE_MAX_AGE_S}, s-maxage=${ROAD_EVENT_CACHE_MAX_AGE_S}`,
      );
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

  // GET /bindings?provider=<provider id>&id=<situation id>
  // The graph bindings of one situation, with why each stands as it does,
  // asked of the provider that published it. A popup reads it on demand: the
  // situation lists carry no bindings. A situation of a disallowed source, or
  // one its provider no longer serves, answers 404; a provider that cannot
  // answer yet (its source list unread) or fails answers 503, uncached.
  ctx.registerRoute("GET", "/bindings", async (req, reply) => {
    const { provider: providerId, id } = scalarQueries(req.query);
    if (
      !providerId ||
      !id ||
      providerId.length > 128 ||
      id.length > 512 ||
      !BINDABLE_SITUATION_ID.test(id)
    ) {
      reply.status(400).send({ error: "provider and an OpenConditions situation id required" });
      return;
    }
    const provider = collectProviders(ctx).find((p) => p.id === providerId);
    if (!provider?.getBindings) {
      reply.status(404).send({ error: "no bindings for this situation" });
      return;
    }
    try {
      const disallowed = [...((await ctx.getDisallowedSourceIds?.()) ?? [])];
      // A situation without bindings is cached as such, so asking for an
      // unknown id again costs no provider read until the entry expires. A
      // provider that cannot answer yet throws, and nothing is cached.
      const cached = await ctx.cache.withCache<RoadConditionBindingDetail | typeof NO_BINDINGS>(
        `conditions:binding:${providerId}:${id}:${disallowed.sort().join("+")}`,
        ROAD_EVENT_CACHE_MAX_AGE_S,
        async () =>
          (await provider.getBindings?.(id, { excludedSourceIds: disallowed })) ?? NO_BINDINGS,
      );
      const detail = !cached || "none" in cached ? null : cached;
      if (!detail) {
        reply.header("Cache-Control", "no-cache");
        reply.status(404).send({ error: "no bindings for this situation" });
        return;
      }
      reply.header("Cache-Control", `private, max-age=${ROAD_EVENT_CACHE_MAX_AGE_S}`);
      reply.send(detail);
    } catch (err) {
      ctx.log.warn("road-conditions binding read failed", err);
      reply.header("Cache-Control", "no-cache");
      reply.status(503).send({ error: "road-condition bindings unavailable" });
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
