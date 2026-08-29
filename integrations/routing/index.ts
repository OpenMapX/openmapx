import {
  type ConnectorStandard,
  type EvVehicleSpec,
  overpassQuerySafe,
  type TravelMode,
} from "@openmapx/core";
import {
  type IntegrationContext,
  parseWgs84BoundingBox,
  parseWgs84Point,
  parseWgs84PointList,
  RoutingProviderError,
  scalarQueries,
} from "@openmapx/integration-framework";
import {
  applyClosureExclusions,
  hashKey,
  resolveTravelInstant,
  round,
} from "./closure-exclusions.js";
import { runEvPlan } from "./ev-plan.js";
import { createRoutingOrchestrator } from "./orchestrator.js";
import type { DirectionsResult } from "./types.js";
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
const MAX_ROUTE_WAYPOINTS = 50;

/**
 * Motorised modes request live speed observations so providers that support
 * them can reflect congestion; foot/bike ignore it. This is the
 * route-handler-layer default the `useLiveTraffic` contract expects callers
 * to supply.
 */
function isMotorisedMode(mode: TravelMode): boolean {
  return mode === "driving" || mode === "motorcycle";
}

function routeMetricValues(result: DirectionsResult): {
  routeCount: number;
  alternateCount: number;
  trafficDelaySeconds?: number;
  baselineAvailable: boolean;
} {
  const activeRoute = result.routes[result.activeRouteIndex] ?? result.routes[0];
  const baseline = activeRoute?.baselineDuration;
  const baselineAvailable =
    typeof baseline === "number" && Number.isFinite(baseline) && baseline >= 0;
  const trafficDelaySeconds =
    baselineAvailable &&
    activeRoute &&
    Number.isFinite(activeRoute.duration) &&
    Number.isFinite(baseline)
      ? activeRoute.duration - baseline
      : undefined;

  return {
    routeCount: result.routes.length,
    alternateCount: Math.max(0, result.routes.length - 1),
    ...(trafficDelaySeconds !== undefined ? { trafficDelaySeconds } : {}),
    baselineAvailable,
  };
}

function recordRoutingRequest(
  ctx: IntegrationContext,
  args: {
    providerId: string;
    mode: TravelMode;
    operation: "directions" | "optimize";
    outcome: "ok" | "error";
    liveTraffic: boolean;
    closureAvoidance: boolean;
    startedAt: number;
    result?: DirectionsResult;
  },
): void {
  const values = args.result ? routeMetricValues(args.result) : { baselineAvailable: false };
  ctx.metricsRecorder?.recordRoutingRequest?.({
    providerId: args.providerId,
    mode: args.mode,
    operation: args.operation,
    outcome: args.outcome,
    liveTraffic: args.liveTraffic,
    closureAvoidance: args.closureAvoidance,
    latencyMs: performance.now() - args.startedAt,
    ...values,
  });
}

function isUnsupportedExclusionsError(error: unknown): boolean {
  return error instanceof RoutingProviderError && error.code === "unsupported-exclusions";
}

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

/** Parse semicolon-separated "lng,lat" pairs into coordinate tuples. */
function parseWaypoints(raw: string): [number, number][] {
  const candidates = raw.split(";").map((pair) => pair.split(","));
  const points = parseWgs84PointList(candidates, { min: 2, max: MAX_ROUTE_WAYPOINTS });
  if (!points) {
    throw new Error(`Waypoints must contain 2-${MAX_ROUTE_WAYPOINTS} valid WGS84 lng,lat pairs`);
  }
  return points;
}

function parseEndpointWaypoints(
  originLng: unknown,
  originLat: unknown,
  destLng: unknown,
  destLat: unknown,
): [number, number][] | null {
  return parseWgs84PointList(
    [
      [originLng, originLat],
      [destLng, destLat],
    ],
    { min: 2, max: 2 },
  );
}

/** Round all waypoints for cache-key stability. */
function roundWaypoints(wps: [number, number][]): [number, number][] {
  return wps.map((wp) => [round(wp[0], 4), round(wp[1], 4)]);
}

/**
 * Parse waypoints from a JSON request body: either `waypoints` (an array of
 * `[lng, lat]` pairs) or the `originLng/originLat/destLng/destLat` shorthand —
 * the same two shapes the GET `/directions` query params accept. Throws when
 * neither shape is present or fewer than 2 waypoints result.
 */
function parseBodyWaypoints(body: Record<string, unknown> | null | undefined): [number, number][] {
  const raw = body?.waypoints;
  let candidates: unknown;
  if (Array.isArray(raw)) {
    candidates = raw;
  } else if (
    body?.originLng != null &&
    body?.originLat != null &&
    body?.destLng != null &&
    body?.destLat != null
  ) {
    candidates = [
      [body.originLng, body.originLat],
      [body.destLng, body.destLat],
    ];
  } else {
    throw new Error(
      "Provide either 'waypoints' (array of [lng, lat] pairs) or originLng/originLat/destLng/destLat",
    );
  }

  const waypoints = parseWgs84PointList(candidates, { min: 2, max: MAX_ROUTE_WAYPOINTS });
  if (!waypoints) {
    throw new Error(`Waypoints must contain 2-${MAX_ROUTE_WAYPOINTS} valid WGS84 points`);
  }
  return waypoints;
}

/** Parse an optional numeric body field; throws a 400 if present but not a finite number in [min,max]. */
function optionalNumberInRange(
  v: unknown,
  name: string,
  min: number,
  max: number,
): number | undefined {
  if (v == null) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) {
    throw Object.assign(new Error(`${name} must be a number between ${min} and ${max}`), {
      status: 400,
    });
  }
  return n;
}

/** Validate a caller-supplied full vehicle spec; throws a 400 if present but malformed. */
function parseVehicleSpec(v: unknown): EvVehicleSpec | undefined {
  if (v == null) return undefined;
  if (typeof v !== "object") {
    throw Object.assign(new Error("vehicle must be an object"), { status: 400 });
  }
  const o = v as Record<string, unknown>;
  const num = (k: string) => Number(o[k]);
  const batteryKwh = num("batteryKwh");
  const baseWhPerKm = num("baseWhPerKm");
  const maxDcKw = num("maxDcKw");
  const maxAcKw = num("maxAcKw");
  const massTonnes = num("massTonnes");
  const vehicleTaperSocPct = num("vehicleTaperSocPct");
  const { connectors } = o;
  if (
    !(batteryKwh > 0) ||
    !(baseWhPerKm > 0) ||
    !(maxDcKw > 0) ||
    !(maxAcKw >= 0) ||
    !Array.isArray(connectors) ||
    connectors.length === 0
  ) {
    throw Object.assign(
      new Error(
        "vehicle spec is invalid: needs positive batteryKwh, baseWhPerKm and maxDcKw, maxAcKw >= 0, and a non-empty connectors array",
      ),
      { status: 400 },
    );
  }
  return {
    batteryKwh,
    baseWhPerKm,
    massTonnes: Number.isFinite(massTonnes) ? massTonnes : 2,
    maxDcKw,
    maxAcKw,
    vehicleTaperSocPct: Number.isFinite(vehicleTaperSocPct) ? vehicleTaperSocPct : 80,
    connectors: connectors as ConnectorStandard[],
  };
}

/**
 * Cache TTL (seconds), tuned for turn-by-turn-grade freshness. Live traffic is
 * refreshed regularly by providers, so any answer that rides current
 * conditions — an immediate ("now") trip, or one departing within the
 * live-traffic horizon — must stay fresh: a short TTL keeps the ETA within
 * roughly one traffic cycle instead of serving a pre-jam number for minutes.
 * A *far-future* pinned departure depends only on the deterministic
 * predicted-speed profiles (rebuilt weekly), so it can be cached aggressively.
 *
 * NOTE: the older assumption that any pinned time is "deterministic" is wrong —
 * a near-now pinned departure still drives current live traffic, so it gets the
 * short TTL, not the long one.
 *
 * Active turn-by-turn navigation must NOT rely on this shared cache: it
 * re-routes continuously against the freshest traffic (and should send
 * `Cache-Control: no-cache`). This cache serves the planning/preview path and
 * dedupes popular identical requests.
 */
const CACHE_TTL_LIVE_SECONDS = 60;
const CACHE_TTL_PREDICTED_SECONDS = 3600;
/**
 * A pinned departure/arrival within this window of "now" still rides current
 * live traffic, so it gets the short live TTL; beyond it, only the (weekly,
 * deterministic) predicted profiles apply and the long TTL is safe.
 */
const LIVE_TRAFFIC_HORIZON_SECONDS = 3600;
/**
 * `stale-while-revalidate` window: the browser/CDN may paint a just-expired
 * response instantly while it refreshes in the background. Kept small so a
 * preview never lags the underlying data by more than ~one extra window.
 */
const STALE_WHILE_REVALIDATE_SECONDS = 30;

/**
 * @param travelInstant the resolved departure/arrival time (TZ-correct), or
 *   `undefined` for an immediate ("now") trip.
 */
export function cacheTtlSeconds(travelInstant: Date | undefined): number {
  if (!travelInstant) return CACHE_TTL_LIVE_SECONDS;
  const offsetSeconds = (travelInstant.getTime() - Date.now()) / 1000;
  return offsetSeconds <= LIVE_TRAFFIC_HORIZON_SECONDS
    ? CACHE_TTL_LIVE_SECONDS
    : CACHE_TTL_PREDICTED_SECONDS;
}

/**
 * Upper bound on `/match` trace size. A typical hour-long drive recorded at
 * 1Hz is ~3.6k points; 10k gives generous headroom while preventing a single
 * caller from queueing a multi-megabyte payload through a routing provider.
 */
const MAX_MATCH_TRACE_POINTS = 10_000;

export function setup(ctx: IntegrationContext): void {
  const { getRoutingProviders, getOptimizeProvider, getMatchProvider } =
    createRoutingOrchestrator(ctx);

  ctx.registerRoute("GET", "/directions", async (req, reply) => {
    const requestStartedAt = performance.now();
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
    } = scalarQueries(req.query);

    let waypoints: [number, number][];

    if (waypointsParam) {
      try {
        waypoints = parseWaypoints(waypointsParam);
      } catch (e) {
        reply.status(400).send({ error: (e as Error).message });
        return;
      }
    } else if (
      originLng !== undefined &&
      originLat !== undefined &&
      destLng !== undefined &&
      destLat !== undefined
    ) {
      const parsed = parseEndpointWaypoints(originLng, originLat, destLng, destLat);
      if (!parsed) {
        reply.status(400).send({ error: "Origin and destination must be valid WGS84 coordinates" });
        return;
      }
      waypoints = parsed;
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

    // Only avoid closures actually in effect at the chosen travel time: the
    // selected departure (or arrival) instant — resolved via the route origin's
    // timezone — falling back to "now" for an immediate trip. Without this a
    // planned-but-not-yet-active closure would wrongly detour a trip planned for
    // before it starts. departAt/arriveBy are already part of the route cache
    // key, so time-varied exclusions stay correctly cached.
    const closureRefTime = resolveTravelInstant(waypoints, departAt, arriveBy);

    const { exclusions, hasExclusions, exclusionsHash } = await applyClosureExclusions(
      ctx,
      waypoints,
      wantClosureAvoidance,
      closureRefTime,
    );

    const keyParams = {
      arriveBy: arriveBy ?? null,
      avoidClosures: wantClosureAvoidance,
      avoidFerries: opts.avoidFerries,
      avoidHighways: opts.avoidHighways,
      avoidTolls: opts.avoidTolls,
      departAt: departAt ?? null,
      exclusionsHash,
      lang: lang ?? "en",
      mode: travelMode,
      units: opts.units,
      waypoints: roundWaypoints(waypoints),
    };

    const requireTimeAware = Boolean(departAt || arriveBy);

    // When exclusions are present, only use providers that explicitly honour
    // the generic exclusion contract. Falling back to an engine that ignores
    // these fields would silently return a route through the closed segment.
    let resolvedChain = getRoutingProviders(travelMode, { requireTimeAware });
    if (hasExclusions) {
      resolvedChain = resolvedChain.filter((e) => e.provider.supportsExclusions === true);
    }

    if (resolvedChain.length === 0) {
      recordRoutingRequest(ctx, {
        providerId: "none",
        mode: travelMode,
        operation: "directions",
        outcome: "error",
        liveTraffic: isMotorisedMode(travelMode),
        closureAvoidance: wantClosureAvoidance,
        startedAt: requestStartedAt,
      });
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
      useLiveTraffic: isMotorisedMode(travelMode),
      ...(hasExclusions && {
        excludeLocations: exclusions.points,
        excludePolygons: exclusions.polygons,
      }),
    };
    const ttl = cacheTtlSeconds(closureRefTime);

    try {
      const result = await ctx.cache.withCache(
        hashKey("cache:directions", keyParams),
        ttl,
        async () => {
          let lastErr: unknown;
          for (const resolved of resolvedChain) {
            const providerStartedAt = performance.now();
            try {
              const r = await resolved.provider.getRoute(waypoints, travelMode, routingOpts);
              ctx.metricsRecorder?.recordProviderCall(
                {
                  providerId: resolved.integrationId,
                  method: "getRoute",
                  outcome: r.routes.length > 0 ? "ok" : "empty",
                },
                performance.now() - providerStartedAt,
              );
              r.provider = resolved.integrationId;
              return r;
            } catch (err) {
              ctx.metricsRecorder?.recordProviderCall(
                { providerId: resolved.integrationId, method: "getRoute", outcome: "error" },
                performance.now() - providerStartedAt,
              );
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
      reply.header(
        "Cache-Control",
        `public, max-age=${ttl}, stale-while-revalidate=${STALE_WHILE_REVALIDATE_SECONDS}`,
      );
      recordRoutingRequest(ctx, {
        providerId: result.provider ?? "unknown",
        mode: travelMode,
        operation: "directions",
        outcome: "ok",
        liveTraffic: isMotorisedMode(travelMode),
        closureAvoidance: wantClosureAvoidance,
        startedAt: requestStartedAt,
        result,
      });
      reply.send(result);
    } catch (err) {
      recordRoutingRequest(ctx, {
        providerId: "none",
        mode: travelMode,
        operation: "directions",
        outcome: "error",
        liveTraffic: isMotorisedMode(travelMode),
        closureAvoidance: wantClosureAvoidance,
        startedAt: requestStartedAt,
      });
      ctx.log.error("All routing providers failed", err as Error);
      reply.status(isUnsupportedExclusionsError(err) ? 503 : 502).send({
        error: isUnsupportedExclusionsError(err)
          ? "Closure avoidance unavailable for this route"
          : "Routing unavailable",
      });
    }
  });

  ctx.registerRoute("GET", "/directions/optimize", async (req, reply) => {
    const requestStartedAt = performance.now();
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
    } = scalarQueries(req.query);

    let waypoints: [number, number][];

    if (waypointsParam) {
      try {
        waypoints = parseWaypoints(waypointsParam);
      } catch (e) {
        reply.status(400).send({ error: (e as Error).message });
        return;
      }
    } else if (
      originLng !== undefined &&
      originLat !== undefined &&
      destLng !== undefined &&
      destLat !== undefined
    ) {
      const parsed = parseEndpointWaypoints(originLng, originLat, destLng, destLat);
      if (!parsed) {
        reply.status(400).send({ error: "Origin and destination must be valid WGS84 coordinates" });
        return;
      }
      waypoints = parsed;
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

    const wantClosureAvoidance = avoidClosures === "true" || avoidClosures === "1";

    // Only avoid closures actually in effect at the chosen travel time: the
    // selected departure (or arrival) instant — resolved via the route origin's
    // timezone — falling back to "now" for an immediate trip. Without this a
    // planned-but-not-yet-active closure would wrongly detour a trip planned for
    // before it starts. departAt/arriveBy are already part of the route cache
    // key, so time-varied exclusions stay correctly cached.
    const closureRefTime = resolveTravelInstant(waypoints, departAt, arriveBy);

    const { exclusions, hasExclusions, exclusionsHash } = await applyClosureExclusions(
      ctx,
      waypoints,
      wantClosureAvoidance,
      closureRefTime,
    );

    const keyParams = {
      arriveBy: arriveBy ?? null,
      avoidClosures: wantClosureAvoidance,
      avoidFerries: opts.avoidFerries,
      avoidHighways: opts.avoidHighways,
      avoidTolls: opts.avoidTolls,
      departAt: departAt ?? null,
      exclusionsHash,
      lang: lang ?? "en",
      mode: travelMode,
      optimize: true,
      units: opts.units,
      waypoints: roundWaypoints(waypoints),
    };

    const requireTimeAware = Boolean(departAt || arriveBy);

    const resolved = getOptimizeProvider(travelMode, { requireTimeAware });

    // When exclusions are present, only use a provider that explicitly honours
    // the generic exclusion contract.
    const effectiveResolved =
      hasExclusions && resolved?.provider.supportsExclusions !== true ? null : resolved;
    const optimizeFn = effectiveResolved?.provider.optimizeRoute;
    if (!effectiveResolved || !optimizeFn) {
      recordRoutingRequest(ctx, {
        providerId: "none",
        mode: travelMode,
        operation: "optimize",
        outcome: "error",
        liveTraffic: isMotorisedMode(travelMode),
        closureAvoidance: wantClosureAvoidance,
        startedAt: requestStartedAt,
      });
      const detail = requireTimeAware
        ? `No time-aware optimize provider available for mode: ${travelMode}`
        : `No optimize provider available for mode: ${travelMode}`;
      reply.status(503).send({ error: detail });
      return;
    }

    const routingOpts = {
      ...opts,
      lang,
      departAt,
      arriveBy,
      useLiveTraffic: isMotorisedMode(travelMode),
      ...(hasExclusions && {
        excludeLocations: exclusions.points,
        excludePolygons: exclusions.polygons,
      }),
    };
    const ttl = cacheTtlSeconds(closureRefTime);

    try {
      const result = await ctx.cache.withCache(
        hashKey("cache:directions:optimize", keyParams),
        ttl,
        async () => {
          const providerStartedAt = performance.now();
          let r: DirectionsResult;
          try {
            r = await optimizeFn(waypoints, travelMode, routingOpts);
            ctx.metricsRecorder?.recordProviderCall(
              {
                providerId: effectiveResolved.integrationId,
                method: "optimizeRoute",
                outcome: r.routes.length > 0 ? "ok" : "empty",
              },
              performance.now() - providerStartedAt,
            );
          } catch (err) {
            ctx.metricsRecorder?.recordProviderCall(
              {
                providerId: effectiveResolved.integrationId,
                method: "optimizeRoute",
                outcome: "error",
              },
              performance.now() - providerStartedAt,
            );
            throw err;
          }
          r.provider = effectiveResolved.integrationId;
          return r;
        },
      );
      reply.header(
        "Cache-Control",
        `public, max-age=${ttl}, stale-while-revalidate=${STALE_WHILE_REVALIDATE_SECONDS}`,
      );
      recordRoutingRequest(ctx, {
        providerId: result.provider ?? "unknown",
        mode: travelMode,
        operation: "optimize",
        outcome: "ok",
        liveTraffic: isMotorisedMode(travelMode),
        closureAvoidance: wantClosureAvoidance,
        startedAt: requestStartedAt,
        result,
      });
      reply.send(result);
    } catch (err) {
      recordRoutingRequest(ctx, {
        providerId: effectiveResolved.integrationId,
        mode: travelMode,
        operation: "optimize",
        outcome: "error",
        liveTraffic: isMotorisedMode(travelMode),
        closureAvoidance: wantClosureAvoidance,
        startedAt: requestStartedAt,
      });
      reply.status(isUnsupportedExclusionsError(err) ? 503 : 502).send({
        error: isUnsupportedExclusionsError(err)
          ? "Closure avoidance unavailable for this route"
          : "Route optimization unavailable",
      });
    }
  });

  /**
   * POST /match — snap a recorded GPS trace to the road network and return
   * per-edge attributes (OSM way ids, surface, speed, names). Not cached:
   * traces are unique per request.
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
      const coordinates = parseWgs84Point(point.lng, point.lat);
      if (!coordinates) {
        reply.status(400).send({ error: "each trace point must be a finite WGS84 coordinate" });
        return;
      }
      const [lng, lat] = coordinates;
      const out: { lat: number; lng: number; time?: string } = {
        lat,
        lng,
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
    const { bbox } = scalarQueries(req.query);
    if (typeof bbox !== "string") {
      reply.status(400).send({ error: "bbox required as 'south,west,north,east'" });
      return;
    }
    const parts = bbox.split(",");
    if (parts.length !== 4) {
      reply.status(400).send({ error: "bbox must be four numbers: south,west,north,east" });
      return;
    }
    const [southRaw, westRaw, northRaw, eastRaw] = parts;
    const southwest = parseWgs84Point(westRaw, southRaw);
    const northeast = parseWgs84Point(eastRaw, northRaw);
    if (!southwest || !northeast || southwest[0] >= northeast[0] || southwest[1] >= northeast[1]) {
      reply.status(400).send({ error: "bbox is invalid or reversed" });
      return;
    }
    const parsed = parseWgs84BoundingBox(
      { south: southRaw, west: westRaw, north: northRaw, east: eastRaw },
      {
        maxLatitudeSpan: 2,
        maxLongitudeSpan: 2,
        maxArea: MAX_ALERT_BBOX_DEG2,
      },
    );
    if (!parsed) {
      // A corridor too large to query in one go is a normal navigation state
      // (long legs), not a client error: answer empty rather than 4xx so the
      // request does not show up as a failure in logs and metrics.
      reply.send({ alerts: [] });
      return;
    }
    const [west, south, east, north] = parsed;

    const key = hashKey(
      "cache:nav:alerts",
      [south, west, north, east].map((n) => round(n, 3)),
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

  /**
   * POST /directions/ev — a driving route with EV charging stops inserted
   * (@openmapx/ev-charge-planner), planned against the selected routing
   * provider, a corridor charger search (ev-charging data-source), and its
   * optional time/distance matrix. Not cached at the HTTP layer beyond
   * `runEvPlan`'s own short-TTL cache (live availability can shift the plan).
   *
   * Body shape:
   *   {
   *     waypoints?: [lng, lat][],                 // or originLng/originLat/destLng/destLat
   *     vehicleId?: string, vehicle?: EvVehicleSpec,
   *     socStartPct: number,                      // required, 0-100
   *     socArrivalMinPct?, socTargetPct?, ambientTempC?, departAt?,
   *     avoidClosures?, avoidTolls?, avoidHighways?, avoidFerries?,
   *     preferredNetworks?, avoidedNetworks?, exclusiveNetworks?, preferCheaper?,
   *     homePricePerKwh?, homeCurrency?, units?, lang?
   *   }
   */
  ctx.registerRoute("POST", "/directions/ev", async (req, reply) => {
    const body = req.body as Record<string, unknown> | null | undefined;

    let planArgs: Parameters<typeof runEvPlan>[2];
    try {
      const waypoints = parseBodyWaypoints(body);
      const socStartPct = Number(body?.socStartPct);
      if (!Number.isFinite(socStartPct) || socStartPct < 0 || socStartPct > 100) {
        throw Object.assign(new Error("socStartPct is required and must be between 0 and 100"), {
          status: 400,
        });
      }
      planArgs = {
        waypoints,
        vehicleId: typeof body?.vehicleId === "string" ? body.vehicleId : undefined,
        vehicle: parseVehicleSpec(body?.vehicle),
        socStartPct,
        socArrivalMinPct: optionalNumberInRange(body?.socArrivalMinPct, "socArrivalMinPct", 0, 100),
        socTargetPct: optionalNumberInRange(body?.socTargetPct, "socTargetPct", 0, 100),
        ambientTempC: optionalNumberInRange(body?.ambientTempC, "ambientTempC", -60, 60),
        departAt: typeof body?.departAt === "string" ? body.departAt : undefined,
        avoidClosures: body?.avoidClosures === true || body?.avoidClosures === "1",
        avoidTolls: !!body?.avoidTolls,
        avoidHighways: !!body?.avoidHighways,
        avoidFerries: !!body?.avoidFerries,
        preferredNetworks: Array.isArray(body?.preferredNetworks)
          ? body.preferredNetworks
          : undefined,
        avoidedNetworks: Array.isArray(body?.avoidedNetworks) ? body.avoidedNetworks : undefined,
        exclusiveNetworks:
          typeof body?.exclusiveNetworks === "boolean" ? body.exclusiveNetworks : undefined,
        preferCheaper: typeof body?.preferCheaper === "boolean" ? body.preferCheaper : undefined,
        homePricePerKwh: optionalNumberInRange(body?.homePricePerKwh, "homePricePerKwh", 0, 100),
        homeCurrency: typeof body?.homeCurrency === "string" ? body.homeCurrency : undefined,
        units: body?.units as "metric" | "imperial" | undefined,
        lang: typeof body?.lang === "string" ? body.lang : undefined,
      };
    } catch (e) {
      const status = (e as { status?: number }).status ?? 400;
      reply.status(status).send({ error: (e as Error).message });
      return;
    }

    try {
      const result = await runEvPlan(ctx, getRoutingProviders, planArgs);
      reply.send(result);
    } catch (e) {
      const status = (e as { status?: number }).status ?? 502;
      reply.status(status).send({ error: (e as Error).message });
    }
  });
}
