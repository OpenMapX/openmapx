import { createHash } from "node:crypto";
import { overpassQuerySafe, type TravelMode } from "@openmapx/core";
import type { IntegrationContext } from "@openmapx/integration-framework";
import { activeClosuresForBbox } from "./closures.js";
import { createRoutingOrchestrator } from "./orchestrator.js";
import { parseDateTime, parseTravelMode } from "./validation.js";

/** A raw (un-projected) approach alert from OSM, returned by /navigation/alerts. */
interface RawRoadAlert {
  id: string;
  type: "speed_camera" | "railway_crossing" | "stop" | "traffic_calming";
  lat: number;
  lng: number;
  speedLimitKmh?: number;
}

/**
 * A route bounding box wider than this (deg², ~a large region) is skipped: a
 * single Overpass query over a cross-country corridor would time out, and the
 * alerts wouldn't fit on screen anyway.
 */
const MAX_ALERT_BBOX_DEG2 = 0.6;

/** Parse an OSM `maxspeed` tag to km/h, or undefined when not a plain number. */
function parseMaxspeedKmh(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Map Overpass nodes to raw approach alerts, by their distinguishing OSM tags. */
function mapAlertElements(
  elements: {
    type: string;
    id: number;
    lat?: number;
    lon?: number;
    tags?: Record<string, string>;
  }[],
): RawRoadAlert[] {
  const out: RawRoadAlert[] = [];
  for (const el of elements) {
    if (el.type !== "node" || el.lat === undefined || el.lon === undefined) continue;
    const tags = el.tags ?? {};
    let type: RawRoadAlert["type"] | null = null;
    let speedLimitKmh: number | undefined;
    if (tags.highway === "speed_camera") {
      type = "speed_camera";
      speedLimitKmh = parseMaxspeedKmh(tags.maxspeed);
    } else if (tags.railway === "level_crossing") {
      type = "railway_crossing";
    } else if (tags.highway === "stop") {
      type = "stop";
    } else if (tags.traffic_calming) {
      type = "traffic_calming";
    }
    if (!type) continue;
    out.push({
      id: `${type}:${el.id}`,
      type,
      lat: el.lat,
      lng: el.lon,
      ...(speedLimitKmh ? { speedLimitKmh } : {}),
    });
  }
  return out;
}

/** Round a number to a fixed number of decimal places. */
function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/** Build a short hash key from a prefix + arbitrary data. */
function hashKey(prefix: string, data: unknown): string {
  const hash = createHash("sha256").update(JSON.stringify(data)).digest("hex").slice(0, 16);
  return `${prefix}:${hash}`;
}

/** Parse semicolon-separated "lng,lat" pairs into coordinate tuples. */
function parseWaypoints(raw: string): [number, number][] {
  return raw.split(";").map((pair) => {
    const [lng, lat] = pair.split(",").map(Number);
    if (Number.isNaN(lng) || Number.isNaN(lat)) {
      throw new Error(`Invalid coordinate pair: "${pair}"`);
    }
    return [lng, lat] as [number, number];
  });
}

/** Round all waypoints for cache-key stability. */
function roundWaypoints(wps: [number, number][]): [number, number][] {
  return wps.map((wp) => [round(wp[0], 4), round(wp[1], 4)]);
}

/**
 * Cache TTL (seconds). When the caller pins a wall-clock (`departAt` or
 * `arriveBy`), the engine response is deterministic for that time and we can
 * cache aggressively. Without a pinned time, Valhalla treats the request as
 * "now" — once predicted-traffic tiles land, the answer drifts as
 * "now" advances, so we keep the implicit-time TTL short.
 */
const CACHE_TTL_PINNED_SECONDS = 3600;
const CACHE_TTL_IMPLICIT_SECONDS = 300;
function cacheTtlSeconds(hasExplicitTime: boolean): number {
  return hasExplicitTime ? CACHE_TTL_PINNED_SECONDS : CACHE_TTL_IMPLICIT_SECONDS;
}

/**
 * Upper bound on `/match` trace size. A typical hour-long drive recorded at
 * 1Hz is ~3.6k points; 10k gives generous headroom while preventing a single
 * caller from queueing a multi-megabyte payload through Valhalla.
 */
const MAX_MATCH_TRACE_POINTS = 10_000;

export function setup(ctx: IntegrationContext): void {
  const { getRoutingProviders, getOptimizeProvider, getMatchProvider } =
    createRoutingOrchestrator(ctx);

  ctx.registerRoute("GET", "/directions", async (req, reply) => {
    const {
      waypoints: waypointsParam,
      originLng,
      originLat,
      destLng,
      destLat,
      mode = "driving",
      avoidHighways,
      avoidTolls,
      avoidFerries,
      avoidClosures,
      units,
      lang,
      departAt: departAtRaw,
      arriveBy: arriveByRaw,
    } = req.query;

    let waypoints: [number, number][];

    if (waypointsParam) {
      try {
        waypoints = parseWaypoints(waypointsParam);
      } catch (e) {
        reply.status(400).send({ error: (e as Error).message });
        return;
      }
    } else if (originLng && originLat && destLng && destLat) {
      waypoints = [
        [Number(originLng), Number(originLat)],
        [Number(destLng), Number(destLat)],
      ];
    } else {
      reply.status(400).send({
        error:
          "Provide either 'waypoints' (semicolon-separated lng,lat pairs) or originLng/originLat/destLng/destLat",
      });
      return;
    }

    if (waypoints.length < 2) {
      reply.status(400).send({ error: "At least 2 waypoints are required" });
      return;
    }

    let travelMode: TravelMode;
    let departAt: string | undefined;
    let arriveBy: string | undefined;
    try {
      travelMode = parseTravelMode(mode);
      departAt = parseDateTime(departAtRaw, "departAt");
      arriveBy = parseDateTime(arriveByRaw, "arriveBy");
    } catch (e) {
      reply.status(400).send({ error: (e as Error).message });
      return;
    }
    if (travelMode === "transit") {
      reply.status(400).send({ error: "Use /api/transit/plan for transit routing" });
      return;
    }
    if (departAt && arriveBy) {
      reply.status(400).send({ error: "departAt and arriveBy are mutually exclusive" });
      return;
    }

    const opts = {
      avoidHighways: avoidHighways === "true",
      avoidTolls: avoidTolls === "true",
      avoidFerries: avoidFerries === "true",
      units: (units ?? "metric") as "metric" | "imperial",
    };

    const wantClosureAvoidance = avoidClosures === "true" || avoidClosures === "1";

    let exclusions: { points: [number, number][]; polygons: [number, number][][] } = {
      points: [],
      polygons: [],
    };
    if (wantClosureAvoidance) {
      const lons = waypoints.map((wp) => wp[0]);
      const lats = waypoints.map((wp) => wp[1]);
      const margin = 0.05;
      const bbox: [number, number, number, number] = [
        Math.min(...lons) - margin,
        Math.min(...lats) - margin,
        Math.max(...lons) + margin,
        Math.max(...lats) + margin,
      ];
      try {
        exclusions = await activeClosuresForBbox(ctx, bbox);
      } catch (err) {
        ctx.log.warn(
          "[routing] failed to fetch closures; routing without exclusions",
          err as Error,
        );
      }
    }

    const hasExclusions = exclusions.points.length > 0 || exclusions.polygons.length > 0;

    const keyParams = {
      arriveBy: arriveBy ?? null,
      avoidClosures: wantClosureAvoidance,
      avoidFerries: opts.avoidFerries,
      avoidHighways: opts.avoidHighways,
      avoidTolls: opts.avoidTolls,
      departAt: departAt ?? null,
      exclusionsHash: hasExclusions
        ? hashKey("excl", { points: exclusions.points, polygons: exclusions.polygons })
        : null,
      lang: lang ?? "en",
      mode: travelMode,
      units: opts.units,
      waypoints: roundWaypoints(waypoints),
    };

    const requireTimeAware = Boolean(departAt || arriveBy);

    // When exclusions are present, restrict to Valhalla — OSRM ignores
    // excludeLocations/excludePolygons and would silently return a route through
    // the closed segment.
    let resolvedChain = getRoutingProviders(travelMode, { requireTimeAware });
    if (hasExclusions) {
      resolvedChain = resolvedChain.filter((e) => e.provider.id === "valhalla");
    }

    if (resolvedChain.length === 0) {
      const detail = requireTimeAware
        ? `No time-aware routing provider available for mode: ${travelMode}`
        : `No routing provider available for mode: ${travelMode}`;
      reply.status(503).send({ error: detail });
      return;
    }

    const routingOpts = {
      ...opts,
      lang,
      departAt,
      arriveBy,
      ...(hasExclusions && {
        excludeLocations: exclusions.points,
        excludePolygons: exclusions.polygons,
      }),
    };
    const ttl = cacheTtlSeconds(requireTimeAware);

    try {
      const result = await ctx.cache.withCache(
        hashKey("cache:directions", keyParams),
        ttl,
        async () => {
          let lastErr: unknown;
          for (const resolved of resolvedChain) {
            try {
              const r = await resolved.provider.getRoute(waypoints, travelMode, routingOpts);
              r.provider = resolved.integrationId;
              return r;
            } catch (err) {
              lastErr = err;
              ctx.log.warn(
                `routing provider ${resolved.integrationId} failed; trying next`,
                err as Error,
              );
            }
          }
          throw lastErr ?? new Error("All routing providers failed");
        },
      );
      reply.header("Cache-Control", `public, max-age=${ttl}`);
      reply.send(result);
    } catch (err) {
      ctx.log.error("All routing providers failed", err as Error);
      reply.status(502).send({ error: "Routing unavailable" });
    }
  });

  ctx.registerRoute("GET", "/directions/optimize", async (req, reply) => {
    const {
      waypoints: waypointsParam,
      originLng,
      originLat,
      destLng,
      destLat,
      mode = "driving",
      avoidHighways,
      avoidTolls,
      avoidFerries,
      units,
      lang,
      departAt: departAtRaw,
      arriveBy: arriveByRaw,
    } = req.query;

    let waypoints: [number, number][];

    if (waypointsParam) {
      try {
        waypoints = parseWaypoints(waypointsParam);
      } catch (e) {
        reply.status(400).send({ error: (e as Error).message });
        return;
      }
    } else if (originLng && originLat && destLng && destLat) {
      waypoints = [
        [Number(originLng), Number(originLat)],
        [Number(destLng), Number(destLat)],
      ];
    } else {
      reply.status(400).send({
        error:
          "Provide either 'waypoints' (semicolon-separated lng,lat pairs) or originLng/originLat/destLng/destLat",
      });
      return;
    }

    if (waypoints.length < 3) {
      reply.status(400).send({ error: "At least 3 waypoints are required for optimization" });
      return;
    }

    let travelMode: TravelMode;
    let departAt: string | undefined;
    let arriveBy: string | undefined;
    try {
      travelMode = parseTravelMode(mode);
      departAt = parseDateTime(departAtRaw, "departAt");
      arriveBy = parseDateTime(arriveByRaw, "arriveBy");
    } catch (e) {
      reply.status(400).send({ error: (e as Error).message });
      return;
    }
    if (travelMode === "transit") {
      reply.status(400).send({ error: "transit routing cannot be optimised here" });
      return;
    }
    if (departAt && arriveBy) {
      reply.status(400).send({ error: "departAt and arriveBy are mutually exclusive" });
      return;
    }

    const opts = {
      avoidHighways: avoidHighways === "true",
      avoidTolls: avoidTolls === "true",
      avoidFerries: avoidFerries === "true",
      units: (units ?? "metric") as "metric" | "imperial",
    };

    const keyParams = {
      arriveBy: arriveBy ?? null,
      avoidFerries: opts.avoidFerries,
      avoidHighways: opts.avoidHighways,
      avoidTolls: opts.avoidTolls,
      departAt: departAt ?? null,
      lang: lang ?? "en",
      mode: travelMode,
      optimize: true,
      units: opts.units,
      waypoints: roundWaypoints(waypoints),
    };

    const requireTimeAware = Boolean(departAt || arriveBy);
    const resolved = getOptimizeProvider(travelMode, { requireTimeAware });
    const optimizeFn = resolved?.provider.optimizeRoute;
    if (!resolved || !optimizeFn) {
      const detail = requireTimeAware
        ? `No time-aware optimize provider available for mode: ${travelMode}`
        : `No optimize provider available for mode: ${travelMode}`;
      reply.status(503).send({ error: detail });
      return;
    }

    const routingOpts = { ...opts, lang, departAt, arriveBy };
    const ttl = cacheTtlSeconds(requireTimeAware);

    try {
      const result = await ctx.cache.withCache(
        hashKey("cache:directions:optimize", keyParams),
        ttl,
        async () => {
          const r = await optimizeFn(waypoints, travelMode, routingOpts);
          r.provider = resolved.integrationId;
          return r;
        },
      );
      reply.header("Cache-Control", `public, max-age=${ttl}`);
      reply.send(result);
    } catch {
      reply.status(502).send({ error: "Route optimization unavailable" });
    }
  });

  /**
   * POST /match — snap a recorded GPS trace to the road network and return
   * per-edge attributes (OSM way ids, surface, speed, names). Backed by
   * Valhalla's `trace_attributes` (Meili HMM map matcher). Not cached: traces
   * are unique per request.
   *
   * Body shape:
   *   {
   *     trace: [{ lat, lng, time? }, ...],   // ≥2 points
   *     mode?: "driving" | "walking" | "cycling",
   *     shapeMatch?: "edge_walk" | "map_snap" | "walk_or_snap"
   *   }
   */
  ctx.registerRoute("POST", "/match", async (req, reply) => {
    const body = req.body as
      | {
          trace?: unknown;
          mode?: unknown;
          shapeMatch?: unknown;
        }
      | null
      | undefined;

    const rawTrace = body?.trace;
    if (!Array.isArray(rawTrace) || rawTrace.length < 2) {
      reply.status(400).send({ error: "trace must be an array of at least 2 points" });
      return;
    }
    if (rawTrace.length > MAX_MATCH_TRACE_POINTS) {
      reply.status(400).send({ error: `trace exceeds the ${MAX_MATCH_TRACE_POINTS}-point limit` });
      return;
    }

    const trace: { lat: number; lng: number; time?: string }[] = [];
    for (const p of rawTrace) {
      if (
        !p ||
        typeof p !== "object" ||
        typeof (p as { lat: unknown }).lat !== "number" ||
        typeof (p as { lng: unknown }).lng !== "number"
      ) {
        reply.status(400).send({ error: "each trace point must have numeric lat and lng" });
        return;
      }
      const point = p as { lat: number; lng: number; time?: unknown };
      const out: { lat: number; lng: number; time?: string } = {
        lat: point.lat,
        lng: point.lng,
      };
      if (typeof point.time === "string") out.time = point.time;
      trace.push(out);
    }

    let travelMode: TravelMode;
    try {
      travelMode = parseTravelMode(typeof body?.mode === "string" ? body.mode : undefined);
    } catch (e) {
      reply.status(400).send({ error: (e as Error).message });
      return;
    }
    if (travelMode === "transit") {
      reply.status(400).send({ error: "transit mode is not supported for map matching" });
      return;
    }

    const shapeMatch =
      typeof body?.shapeMatch === "string" &&
      ["edge_walk", "map_snap", "walk_or_snap"].includes(body.shapeMatch)
        ? (body.shapeMatch as "edge_walk" | "map_snap" | "walk_or_snap")
        : undefined;

    const resolved = getMatchProvider(travelMode);
    if (!resolved?.provider.getMatch) {
      reply
        .status(503)
        .send({ error: `No map-matching provider available for mode: ${travelMode}` });
      return;
    }

    try {
      const result = await resolved.provider.getMatch(trace, travelMode, { shapeMatch });
      result.provider = resolved.integrationId;
      reply.send(result);
    } catch (err) {
      ctx.log.error("map matching failed", err as Error);
      reply.status(502).send({ error: "Map matching unavailable" });
    }
  });

  /**
   * GET /navigation/alerts — approach alerts (speed cameras, level crossings,
   * stop signs, traffic calming) from OSM within a bounding box, for the live
   * navigation alert layer. Static-ish, so cached for a day. Bounding boxes
   * larger than {@link MAX_ALERT_BBOX_DEG2} return empty to avoid Overpass
   * timeouts on long routes. Speed-camera legality is enforced client-side.
   */
  ctx.registerRoute("GET", "/navigation/alerts", async (req, reply) => {
    const { bbox } = req.query;
    if (typeof bbox !== "string") {
      reply.status(400).send({ error: "bbox required as 'south,west,north,east'" });
      return;
    }
    const parts = bbox.split(",").map(Number);
    if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) {
      reply.status(400).send({ error: "bbox must be four numbers: south,west,north,east" });
      return;
    }
    const [south, west, north, east] = parts;
    if (Math.abs(north - south) * Math.abs(east - west) > MAX_ALERT_BBOX_DEG2) {
      reply.send({ alerts: [] }); // corridor too large to query in one go
      return;
    }

    const key = hashKey(
      "cache:nav:alerts",
      parts.map((n) => round(n, 3)),
    );
    try {
      const result = await ctx.cache.withCache(key, 86_400, async () => {
        const b = `${south},${west},${north},${east}`;
        const query = `[out:json][timeout:25];(node["highway"="speed_camera"](${b});node["railway"="level_crossing"](${b});node["highway"="stop"](${b});node["traffic_calming"](${b}););out body;`;
        const data = await overpassQuerySafe(query, null);
        return { alerts: data ? mapAlertElements(data.elements) : [] };
      });
      reply.header("Cache-Control", "public, max-age=86400");
      reply.send(result);
    } catch {
      reply.send({ alerts: [] }); // optional layer: never fail navigation over it
    }
  });
}
