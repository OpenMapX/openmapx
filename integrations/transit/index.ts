import { randomUUID } from "node:crypto";
import {
  type BBox,
  normalizeSearchTerm,
  overpassQuery,
  type SearchSuggestionProviderResult,
  type SearchSuggestionQuery,
  TIME_AWARE_TEMPORAL_DEFAULT,
} from "@openmapx/core";
import {
  type BoundingBoxLimits,
  clampViewportBoundingBox,
  type IntegrationContext,
  listQuery,
  type ProviderCallContext,
  parsePositiveRadius,
  parseWgs84Point,
  type SearchSuggestionProvider,
  scalarQueries,
  type TransitProvider,
  type TripPlanRequest,
} from "@openmapx/integration-framework";
import type { Attribution } from "@openmapx/mobility-core/attribution";
import {
  captureResultContributors,
  contributorsForRecords,
  snapshotContributors,
} from "@openmapx/mobility-core/contributors";
import type { Freshness } from "@openmapx/mobility-core/freshness";
import type { MobilityEnvelope, MobilityResult } from "@openmapx/mobility-core/result";
import type {
  GeoJSONLineString,
  TransitStop,
  TransitTripResolveRequest,
  TripItinerary,
} from "@openmapx/mobility-core/transit";
import {
  parseTransitIsochroneRequest,
  TRANSIT_ISOCHRONE_METHOD,
  type TransitIsochroneRequest,
  type TransitIsochroneResult,
} from "@openmapx/mobility-core/transit-isochrone";
import {
  parseTransitReachabilityCheckRequest,
  parseTransitReachabilitySurfaceRequest,
  type TransitReachabilityCheckRequest,
  type TransitReachabilitySurfaceRequest,
} from "@openmapx/mobility-core/transit-reachability";
import { getPlaceResolver } from "@openmapx/place-ids";
import { planTransitChain } from "./chain-plan.js";
import { ChainRequestValidationError, parseChainRequest } from "./chain-request.js";
import {
  buildIsochroneFeatureCollection,
  samplingFromField,
  transitIsochroneFieldCacheKey,
  withSingleFlight,
} from "./isochrone.js";
import {
  AnchoredDeparturesUnsupported,
  createTransitOrchestrator,
  UnsupportedTransitPlanningCapabilitiesError,
} from "./orchestrator.js";
import {
  signTransitPageToken,
  transitRequestFingerprint,
  verifyTransitPageToken,
} from "./page-token.js";
import { createPlaceTransit, type PlaceQuery } from "./place-transit.js";
import {
  thinTransitReachabilitySurface,
  transitCheckCacheKey,
  transitSurfaceCacheKey,
} from "./reachability.js";
import { createRefreshReplay } from "./refresh-replay.js";
import { signRefreshHandle, verifyRefreshHandle } from "./refresh-token.js";
import { parseStopAreaQuery, resolveStopArea, stopAreaCacheKey } from "./stop-area.js";
import {
  parseTripReferenceRequest,
  TripReferenceEpochError,
  TripReferenceUnavailableError,
  TripReferenceUnsupportedError,
  TripReferenceValidationError,
} from "./trip-reference.js";

/**
 * Strip the server-only `trace` field from a MobilityResult and return the
 * `{ data, attributions, freshness }` envelope sent on the wire.
 */
/** Stops and platforms move rarely; a week keeps Overpass out of most trips. */
const STOP_AREA_TTL_SECONDS = 7 * 24 * 60 * 60;

function toEnvelope<T>(result: MobilityResult<T>): MobilityEnvelope<T> {
  return {
    data: result.data,
    attributions: result.attributions,
    freshness: result.freshness,
  };
}

/**
 * Browser and shared-cache policy for a result. A partial answer is not stored,
 * so a recovered source shows up on the next request. Set it once the result
 * exists, so a failed request doesn't carry a cacheable header either.
 */
function cacheControl(freshness: Freshness, complete: string): string {
  return freshness.isPartial ? "no-store" : complete;
}

/** Build an envelope from raw data + a fresh attribution/freshness pair. */
function envelope<T>(
  data: T,
  attributions: Attribution[],
  freshness: Freshness,
): MobilityEnvelope<T> {
  return { data, attributions, freshness };
}

interface TransitSearchOrchestrator {
  searchByName(
    query: string,
    limit: number,
    context?: ProviderCallContext,
  ): Promise<MobilityResult<TransitStop[]>>;
}

export function createTransitSuggestionProvider(
  orchestrator: TransitSearchOrchestrator,
): SearchSuggestionProvider {
  return {
    id: "transit",
    async searchSuggestions(
      query: SearchSuggestionQuery,
      context,
    ): Promise<SearchSuggestionProviderResult> {
      const result = await orchestrator.searchByName(query.query, query.limit, context);
      const normalizedQuery = normalizeSearchTerm(query.query);
      return {
        suggestions: result.data.map((stop) => {
          const exactCode = stop.codes?.find(
            ({ value }) => normalizeSearchTerm(value) === normalizedQuery,
          );
          const matchedValue = exactCode?.value ?? stop.name;
          return {
            contributors: captureResultContributors(stop, result.attributions),
            id: stop.id,
            ids: stop.ids,
            label: stop.name,
            sublabel: exactCode ? exactCode.namespace.toUpperCase() : undefined,
            coordinates: [stop.lng, stop.lat],
            type: "transit_stop" as const,
            transitStop: stop,
            rawCategory: "public_transport/station",
            searchMatch: {
              kind: exactCode ? ("authoritative_code" as const) : ("name" as const),
              value: matchedValue,
              normalized: normalizeSearchTerm(matchedValue),
              namespace: exactCode?.namespace,
            },
            importance: 0.7,
            provider: "transit",
            contributingProviders: ["transit"],
          };
        }),
        attributions: contributorsForRecords(
          result.data.map((stop) => ({
            contributors: captureResultContributors(stop, result.attributions),
          })),
        ),
        freshnessSeconds: 300,
      };
    },
  };
}

function parseBBox(q: Record<string, string>): BBox | null {
  return clampViewportBoundingBox(
    { west: q.sw_lng, south: q.sw_lat, east: q.ne_lng, north: q.ne_lat },
    TRANSIT_BBOX_LIMITS,
  );
}

const TRANSIT_BBOX_LIMITS: BoundingBoxLimits = {
  maxLatitudeSpan: 30,
  maxLongitudeSpan: 60,
  maxArea: 900,
};

function parsePlaceQuery(q: Record<string, string>): PlaceQuery | null {
  const name = q.name?.trim();
  const point = parseWgs84Point(q.lng, q.lat);
  if (!point || !name) return null;
  const [lng, lat] = point;
  const osmRef = q.osm_id?.trim();
  const stopName = q.stop_name?.trim().slice(0, 200);
  return {
    lat,
    lng,
    name,
    ...(q.place_id ? { placeId: q.place_id } : {}),
    ...(osmRef ? { osmRef } : {}),
    ...(stopName ? { stopName } : {}),
  };
}

function parseMinutes(raw: string | undefined, defaultVal = 60, max = 120): number | null {
  const minutes = Math.min(Number(raw ?? defaultVal), max);
  return Number.isFinite(minutes) && minutes > 0 ? minutes : null;
}

function parseModes(raw: string | undefined): string[] | undefined {
  return raw ? raw.split(",").map((m) => m.trim()) : undefined;
}

const RENTAL_FORM_FACTORS = new Set([
  "BICYCLE",
  "CARGO_BICYCLE",
  "SCOOTER_STANDING",
  "SCOOTER_SEATED",
  "CAR",
  "MOPED",
]);

function parseBoundedList(raw: string | undefined, allowed?: ReadonlySet<string>): string[] {
  return [
    ...new Set(
      (raw ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter((value) => value && (!allowed || allowed.has(value))),
    ),
  ].slice(0, 50);
}

export function routeZoomBucket(raw: string | undefined): number {
  const parsed = Number(raw ?? 12);
  const zoom = Number.isFinite(parsed) ? Math.min(18, Math.max(0, Math.floor(parsed))) : 12;
  if (zoom >= 16) return 16;
  if (zoom >= 14) return 14;
  if (zoom >= 12) return 12;
  return 10;
}

/** MOTIS refresh is only safe for station-to-station or walk-ended itineraries. */
export function isRefreshEligible(itinerary: TripItinerary): boolean {
  if (!itinerary.id || itinerary.legs.length === 0) return false;
  if (itinerary.legs.some((leg) => leg.rental || ["cycling", "driving"].includes(leg.mode))) {
    return false;
  }
  const first = itinerary.legs[0];
  const last = itinerary.legs.at(-1);
  return Boolean(
    first &&
      last &&
      ((first.mode === "walking" && last.mode === "walking") ||
        (first.from.stopId && last.to.stopId)),
  );
}

function utcDate(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * The requested planning instant as a UTC ISO string, or null when the input is
 * malformed. A `time` containing `T` is a full date-time; otherwise `date`
 * (default today) and `time` (default now) are a UTC calendar date and clock.
 */
export function planInstant(
  date: string | undefined,
  time: string | undefined,
  now = new Date(),
): string | null {
  if (time?.includes("T")) {
    const instant = new Date(time);
    return Number.isFinite(instant.getTime()) ? `${instant.toISOString().slice(0, 19)}Z` : null;
  }
  if (date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  if (time !== undefined && !/^\d{2}:\d{2}(:\d{2})?$/.test(time)) return null;
  const day = date ?? now.toISOString().slice(0, 10);
  const clock = time ? (time.length === 5 ? `${time}:00` : time) : now.toISOString().slice(11, 19);
  const instant = new Date(`${day}T${clock}Z`);
  if (!Number.isFinite(instant.getTime())) return null;
  // Reject calendar or clock values the parser would roll over, such as 02-30 or 24:00.
  if (instant.toISOString().slice(0, 19) !== `${day}T${clock}`) return null;
  return `${day}T${clock}Z`;
}

function reachabilityFailure(error: unknown, signal?: AbortSignal) {
  const raw = (error as { code?: unknown }).code;
  const errorKind = [
    "unavailable",
    "timeout",
    "invalid-response",
    "unsupported",
    "upstream",
  ].includes(String(raw))
    ? (raw as "unavailable" | "timeout" | "invalid-response" | "unsupported" | "upstream")
    : signal?.aborted
      ? "timeout"
      : "upstream";
  return {
    errorKind,
    outcome: signal?.aborted
      ? ("cancelled" as const)
      : errorKind === "timeout"
        ? ("timeout" as const)
        : errorKind === "unavailable" || errorKind === "unsupported"
          ? ("unavailable" as const)
          : ("error" as const),
  };
}

export function setup(ctx: IntegrationContext): void {
  const orchestrator = createTransitOrchestrator(ctx);
  ctx.registerSearchSuggestionProvider(createTransitSuggestionProvider(orchestrator));
  const refreshSecret = process.env.BETTER_AUTH_SECRET ?? "";
  const refreshTtlSeconds = 15 * 60;

  interface RefreshState {
    kind?: "search";
    providerId: string;
    instance: string;
    datasetEpoch: string;
    requestFingerprint: string;
    itineraryId: string;
    request: TripPlanRequest;
  }

  interface ReferenceRefreshState {
    kind: "reference";
    request: TransitTripResolveRequest;
  }

  async function issueReferenceRefreshToken(
    itinerary: TripItinerary,
    request: TransitTripResolveRequest,
  ): Promise<string | undefined> {
    if (!isRefreshEligible(itinerary) || !refreshSecret) return undefined;
    const id = randomUUID();
    const state: ReferenceRefreshState = { kind: "reference", request };
    // Refresh-token session state, not cached upstream data.
    await ctx.cache.set(`transit-refresh:${id}`, state, refreshTtlSeconds);
    return signRefreshHandle(id, refreshSecret, Math.floor(Date.now() / 1000) + refreshTtlSeconds);
  }

  async function issueRefreshToken(
    itinerary: TripItinerary,
    providerId: string,
    instance: string,
    datasetEpoch: string,
    requestFingerprint: string,
    request: TripPlanRequest,
  ): Promise<string | undefined> {
    if (!isRefreshEligible(itinerary) || !refreshSecret || !itinerary.id) return undefined;
    const id = randomUUID();
    const expiresAt = Math.floor(Date.now() / 1000) + refreshTtlSeconds;
    const state: RefreshState = {
      providerId,
      instance,
      datasetEpoch,
      requestFingerprint,
      itineraryId: itinerary.id,
      request,
    };
    // Refresh-token session state, not cached upstream data.
    await ctx.cache.set(`transit-refresh:${id}`, state, refreshTtlSeconds);
    return signRefreshHandle(id, refreshSecret, expiresAt);
  }

  ctx.registerRoute("GET", "/planning-capabilities", async (_req, reply) => {
    const providers = orchestrator
      .collectProviders()
      .filter((provider) => provider.capabilities.planning)
      .map((provider) => ({
        id: provider.id,
        features: provider.capabilities.planningFeatures,
        metadata: provider.planningMetadata,
      }));
    reply.header("Cache-Control", "private, max-age=60");
    reply.send({ providers });
  });
  const placeTransit = createPlaceTransit(ctx, orchestrator, {
    // The OSM place resolver, which the geocoding integration registers with the
    // operator's Nominatim; without it, places link by their shown name.
    lookupLocalName: async (osmRef) => {
      const resolve = getPlaceResolver<{ localName?: string }>("osm");
      return resolve ? ((await resolve(osmRef, {}))?.localName ?? undefined) : undefined;
    },
  });

  // GET /stops
  ctx.registerRoute("GET", "/stops", async (req, reply) => {
    const bbox = parseBBox(scalarQueries(req.query));
    if (!bbox) {
      reply
        .status(400)
        .send({ error: "Invalid or missing bbox params (sw_lat, sw_lng, ne_lat, ne_lng)" });
      return;
    }
    const result = await orchestrator.getStopsInBbox(
      bbox,
      parseModes(scalarQueries(req.query).modes),
    );
    reply.send(toEnvelope(result));
  });

  // GET /stops/nearby
  ctx.registerRoute("GET", "/stops/nearby", async (req, reply) => {
    const point = parseWgs84Point(scalarQueries(req.query).lng, scalarQueries(req.query).lat, {
      maxAbsLatitude: 85,
    });
    const radiusMeters = parsePositiveRadius(scalarQueries(req.query).radius, {
      defaultValue: 500,
      max: 2_000,
    });
    if (!point || radiusMeters === null) {
      reply.status(400).send({ error: "Required: valid lat, lng, and radius in (0, 2000]" });
      return;
    }
    const [lng, lat] = point;
    const latDelta = radiusMeters / 111_320;
    const lngDelta = radiusMeters / (111_320 * Math.cos((lat * Math.PI) / 180));
    const bbox: BBox = [lng - lngDelta, lat - latDelta, lng + lngDelta, lat + latDelta];
    reply.header("Cache-Control", "public, max-age=300, s-maxage=300");
    const result = await orchestrator.getStopsInBbox(
      bbox,
      parseModes(scalarQueries(req.query).modes),
    );
    reply.send(toEnvelope(result));
  });

  // GET /stops/search
  ctx.registerRoute("GET", "/stops/search", async (req, reply) => {
    const query = scalarQueries(req.query).q?.trim();
    if (!query || query.length < 2) {
      reply.status(400).send({ error: "Query parameter 'q' must be at least 2 characters" });
      return;
    }
    const limit = Math.min(Math.max(Number(scalarQueries(req.query).limit) || 5, 1), 20);
    const stops = await orchestrator.searchByName(query, limit);
    reply.header(
      "Cache-Control",
      cacheControl(stops.freshness, "public, max-age=300, s-maxage=300"),
    );
    reply.send(toEnvelope(stops));
  });

  // GET /stops/near-place
  ctx.registerRoute("GET", "/stops/near-place", async (req, reply) => {
    const place = parsePlaceQuery(scalarQueries(req.query));
    if (!place) {
      reply.status(400).send({ error: "Required: lat, lng, name" });
      return;
    }
    const result = await placeTransit.getLinkedStops(place);
    reply.header(
      "Cache-Control",
      cacheControl(result.freshness, "public, max-age=86400, s-maxage=86400"),
    );
    reply.send(toEnvelope(result));
  });

  // GET /stops/:id
  ctx.registerRoute("GET", "/stops/:id", async (req, reply) => {
    const res = await orchestrator.getStop(req.params.id);
    if (!res.data) {
      reply.status(404).send({ error: "Stop not found" });
      return;
    }
    reply.send(toEnvelope(res));
  });

  // GET /stops/:id/transfers — accessibility-annotated transfers out of a stop.
  ctx.registerRoute("GET", "/stops/:id/transfers", async (req, reply) => {
    const stopId = req.params.id;
    const cacheKey = `stop-transfers:${stopId}`;
    const env = await ctx.cache.withCache(cacheKey, 3600, async () =>
      toEnvelope(await orchestrator.getStopTransfers(stopId)),
    );
    reply.header("Cache-Control", "public, max-age=600, s-maxage=3600");
    reply.send(env);
  });

  // GET /stops/:id/infrastructure
  ctx.registerRoute("GET", "/stops/:id/infrastructure", async (req, reply) => {
    const stopId = req.params.id;
    const cacheKey = `stop-infra:${stopId}`;
    let env: MobilityEnvelope<unknown> | null = null;
    try {
      env = await ctx.cache.withCache(cacheKey, 86400, async () => {
        const res = await orchestrator.getStopInfrastructure(stopId);
        if (!res.data) throw new Error("infrastructure unavailable");
        return toEnvelope(res);
      });
    } catch {
      env = null;
    }
    if (!env?.data) {
      reply.status(404).send({ error: "Stop infrastructure not found" });
      return;
    }
    reply.header("Cache-Control", "public, max-age=3600, s-maxage=86400");
    reply.send(env);
  });

  // GET /stops/:id/area — the stop's platform and stop place, for navigation
  // to decide that a rider reached it. 204 when nothing beyond its point is known.
  ctx.registerRoute("GET", "/stops/:id/area", async (req, reply) => {
    const query = parseStopAreaQuery(decodeURIComponent(req.params.id), scalarQueries(req.query));
    if (!query) {
      reply.status(400).send({ error: "Invalid stop area query" });
      return;
    }
    const resolved = await ctx.cache.withCache(
      stopAreaCacheKey(query),
      STOP_AREA_TTL_SECONDS,
      () =>
        resolveStopArea(query, {
          overpass: overpassQuery,
          siblings: (stopId) => orchestrator.getStopPlatforms(stopId),
        }),
      undefined,
      (value) => value.complete,
    );
    // A lookup a source failed is worse than the next one will be: keep it
    // out of every cache, not only the server's.
    reply.header(
      "Cache-Control",
      resolved.complete ? "public, max-age=86400, s-maxage=604800" : "no-store",
    );
    if (!resolved.area) {
      reply.status(204).send(null);
      return;
    }
    reply.send(
      envelope(resolved.area, resolved.attributions, {
        fetchedAt: new Date().toISOString(),
        hasRealtimeData: false,
        isStale: false,
      }),
    );
  });

  // GET /stops/:id/platform-stops
  ctx.registerRoute("GET", "/stops/:id/platform-stops", async (req, reply) => {
    reply.header("Cache-Control", "public, max-age=3600, s-maxage=3600");
    const result = await orchestrator.getStopPlatforms(req.params.id);
    reply.send(toEnvelope(result));
  });

  // GET /stops/:id/timetable
  ctx.registerRoute("GET", "/stops/:id/timetable", async (req, reply) => {
    const date = scalarQueries(req.query).date ?? utcDate();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      reply.status(400).send({ error: "Invalid date format. Use YYYY-MM-DD." });
      return;
    }
    const isPast = date < utcDate();
    reply.header(
      "Cache-Control",
      isPast ? "public, max-age=86400, s-maxage=86400" : "public, max-age=300, s-maxage=300",
    );
    const result = await orchestrator.getStopTimetable(req.params.id, date);
    reply.send(toEnvelope(result));
  });

  // GET /stops/:id/departures
  ctx.registerRoute("GET", "/stops/:id/departures", async (req, reply) => {
    const minutes = parseMinutes(scalarQueries(req.query).minutes);
    if (!minutes) {
      reply.status(400).send({ error: "Invalid minutes param" });
      return;
    }
    const rawTime = scalarQueries(req.query).time;
    if (
      rawTime !== undefined &&
      (rawTime.length > 40 ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(rawTime) ||
        !Number.isFinite(Date.parse(rawTime)) ||
        new Date(rawTime).toISOString().slice(0, 10) !== rawTime.slice(0, 10))
    ) {
      reply.status(400).send({ error: "Invalid time; use an ISO UTC timestamp" });
      return;
    }
    const time = rawTime === undefined ? undefined : new Date(rawTime).toISOString();
    reply.header("Cache-Control", time ? "no-store" : "public, max-age=30, s-maxage=30");
    const stopId = req.params.id;
    const cacheKey = `transit:departures:${stopId}:${minutes}${time ? `:${time}` : ""}`;
    try {
      const result = await ctx.cache.withCache(cacheKey, 30, async () => {
        const res = await orchestrator.getDepartures(stopId, minutes, time);
        return toEnvelope(res);
      });
      reply.send(result);
    } catch (error) {
      if (error instanceof AnchoredDeparturesUnsupported) {
        reply.status(501).send({ error: "This source does not support dated departure lookups" });
        return;
      }
      if (error instanceof TripReferenceUnavailableError) {
        reply.status(503).send({ error: "Transit timetable source unavailable" });
        return;
      }
      throw error;
    }
  });

  // GET /stops/:id/arrivals
  ctx.registerRoute("GET", "/stops/:id/arrivals", async (req, reply) => {
    const minutes = parseMinutes(scalarQueries(req.query).minutes);
    if (!minutes) {
      reply.status(400).send({ error: "Invalid minutes param" });
      return;
    }
    reply.header("Cache-Control", "public, max-age=60, s-maxage=60");
    const stopId = req.params.id;
    const cacheKey = `transit:arrivals:${stopId}:${minutes}`;
    const result = await ctx.cache.withCache(cacheKey, 60, async () => {
      const res = await orchestrator.getArrivals(stopId, minutes);
      return toEnvelope(res);
    });
    reply.send(result);
  });

  // GET /stops/:id/alerts
  ctx.registerRoute("GET", "/stops/:id/alerts", async (req, reply) => {
    const stopId = req.params.id;
    const cacheKey = `transit:stop-alerts:${stopId}`;
    const alerts = await ctx.cache.withCache(cacheKey, 60, async () => {
      const res = await orchestrator.getStopAlerts(stopId);
      return toEnvelope(res);
    });
    reply.header("Cache-Control", "public, max-age=60, s-maxage=60");
    reply.send(alerts);
  });

  // GET /stops/:id/facilities
  ctx.registerRoute("GET", "/stops/:id/facilities", async (req, reply) => {
    const result = await orchestrator.getFacilities(req.params.id);
    reply.send(toEnvelope(result));
  });

  // GET /routes
  ctx.registerRoute("GET", "/routes", async (req, reply) => {
    if (scalarQueries(req.query).stop_id) {
      const stopId = scalarQueries(req.query).stop_id;
      const cacheKey = `transit:routes-for-stop:${stopId}`;
      const routes = await ctx.cache.withCache(cacheKey, 300, async () => {
        const res = await orchestrator.getRoutesForStop(stopId);
        return toEnvelope(res);
      });
      reply.send(routes);
      return;
    }
    const bbox = parseBBox(scalarQueries(req.query));
    if (!bbox) {
      reply.status(400).send({ error: "Provide stop_id or valid bbox params" });
      return;
    }
    // The network overlay refetches on every moveend (and on style/theme
    // changes), so cache by a coarsened bbox (~110m) to collapse near-identical
    // viewports onto one upstream MOTIS call instead of hammering the always-on
    // cloud instance.
    reply.header("Cache-Control", "public, max-age=120, s-maxage=120");
    const zoom = routeZoomBucket(scalarQueries(req.query).zoom);
    const cacheKey = `transit:routes-bbox:${zoom}:${bbox.map((n) => n.toFixed(3)).join(",")}`;
    const routes = await ctx.cache.withCache(cacheKey, 120, async () => {
      const res = await orchestrator.getRoutesInBbox(bbox, zoom);
      return toEnvelope(res);
    });
    reply.send(routes);
  });

  // GET /routes/for-place
  ctx.registerRoute("GET", "/routes/for-place", async (req, reply) => {
    const place = parsePlaceQuery(scalarQueries(req.query));
    if (!place) {
      reply.status(400).send({ error: "Required: lat, lng, name" });
      return;
    }
    const result = await placeTransit.getMergedRoutes(place);
    reply.header(
      "Cache-Control",
      cacheControl(result.freshness, "public, max-age=300, s-maxage=300"),
    );
    reply.send(toEnvelope(result));
  });

  // GET /routes/:id
  ctx.registerRoute("GET", "/routes/:id", async (req, reply) => {
    const routeId = req.params.id;
    const cacheKey = `transit:route:${routeId}`;
    const env = await ctx.cache.withCache(
      cacheKey,
      3600,
      async () => toEnvelope(await orchestrator.getRoute(routeId)),
      undefined,
      (found) => Boolean(found.data),
    );
    if (!env.data) {
      reply.status(404).send({ error: "Route not found" });
      return;
    }
    reply.send(env);
  });

  // GET /routes/:id/stops
  ctx.registerRoute("GET", "/routes/:id/stops", async (req, reply) => {
    const routeId = req.params.id;
    const hintStopId = scalarQueries(req.query).hint_stop_id || undefined;
    const cacheKey = `transit:route-stops:${routeId}:${hintStopId ?? ""}`;
    const env = await ctx.cache.withCache(
      cacheKey,
      3600,
      async () => toEnvelope(await orchestrator.getRouteStops(routeId, hintStopId)),
      undefined,
      (stops) => Array.isArray(stops.data) && stops.data.length > 0,
    );
    reply.send(env);
  });

  // GET /routes/:id/alerts
  ctx.registerRoute("GET", "/routes/:id/alerts", async (req, reply) => {
    reply.header("Cache-Control", "public, max-age=60, s-maxage=60");
    const routeId = req.params.id;
    const cacheKey = `transit:route-alerts:${routeId}`;
    const alerts = await ctx.cache.withCache(cacheKey, 60, async () => {
      const res = await orchestrator.getRouteAlerts(routeId);
      return toEnvelope(res);
    });
    reply.send(alerts);
  });

  // GET /routes/:id/live
  ctx.registerRoute("GET", "/routes/:id/live", async (req, reply) => {
    reply.header("Cache-Control", "public, max-age=15, s-maxage=15");
    const routeId = req.params.id;
    const [vehicles, alerts] = await Promise.all([
      orchestrator.getVehiclePositions(routeId),
      orchestrator.getRouteAlerts(routeId),
    ]);
    const mergedAttrs = snapshotContributors(vehicles.attributions, alerts.attributions);
    const mergedFreshness: Freshness = {
      fetchedAt:
        vehicles.freshness.fetchedAt < alerts.freshness.fetchedAt
          ? vehicles.freshness.fetchedAt
          : alerts.freshness.fetchedAt,
      hasRealtimeData: vehicles.freshness.hasRealtimeData || alerts.freshness.hasRealtimeData,
      isStale: vehicles.freshness.isStale || alerts.freshness.isStale,
    };
    reply.send(
      envelope({ vehicles: vehicles.data, alerts: alerts.data }, mergedAttrs, mergedFreshness),
    );
  });

  // GET /leg-geometry
  ctx.registerRoute("GET", "/leg-geometry", async (req, reply) => {
    const tripId = scalarQueries(req.query).trip_id?.trim();
    if (!tripId) {
      reply.status(400).send({ error: "Required: trip_id" });
      return;
    }
    const fromStopId = scalarQueries(req.query).from_stop_id?.trim() || undefined;
    const toStopId = scalarQueries(req.query).to_stop_id?.trim() || undefined;
    // Trip polylines are static (trains always follow the same track), so cache
    // aggressively in Redis to avoid hammering the dbweb endpoint on every request.
    // Throw inside the callback when geometry is null so withCache does not
    // persist the failure — a transient dbweb timeout would otherwise lock the
    // trip into a 24h 404.
    const cacheKey = `leg-geo:${tripId}:${fromStopId ?? ""}:${toStopId ?? ""}`;
    let geometry: MobilityEnvelope<GeoJSONLineString> | null = null;
    try {
      geometry = await ctx.cache.withCache(cacheKey, 86400, async () => {
        const res = await orchestrator.getLegGeometry(tripId, fromStopId, toStopId);
        if (!res.data) throw new Error("geometry unavailable");
        return toEnvelope(res as MobilityResult<GeoJSONLineString>);
      });
    } catch {
      // geometry remains null — transient failure, not cached
    }
    if (!geometry?.data) {
      reply.status(404).send({ error: "Geometry not available for this trip" });
      return;
    }
    reply.header("Cache-Control", "public, max-age=3600, s-maxage=3600");
    reply.send(geometry);
  });

  // GET /plan
  ctx.registerRoute(
    "GET",
    "/plan",
    async (req, reply) => {
      const q = scalarQueries(req.query);
      const from = parseWgs84Point(q.from_lng, q.from_lat);
      const to = parseWgs84Point(q.to_lng, q.to_lat);
      if (!from || !to) {
        reply.status(400).send({
          error: "Invalid or missing coordinate params (from_lat, from_lng, to_lat, to_lng)",
        });
        return;
      }
      const [fromLng, fromLat] = from;
      const [toLng, toLat] = to;
      const when = planInstant(q.date, q.time);
      if (!when) {
        reply.status(400).send({
          error:
            "time must be an ISO 8601 date-time, or HH:MM[:SS] with an optional YYYY-MM-DD date",
        });
        return;
      }
      reply.header("Cache-Control", "private, max-age=60");
      // `time` is an arrival deadline when arrive_by is set, otherwise a departure.
      const arriveBy = q.arrive_by === "true";
      const numItinerariesRaw = Number(q.num_itineraries);
      const numItineraries =
        Number.isFinite(numItinerariesRaw) && numItinerariesRaw > 0
          ? Math.min(Math.floor(numItinerariesRaw), 10)
          : undefined;
      const maxTransfersRaw = q.max_transfers === undefined ? undefined : Number(q.max_transfers);
      if (
        maxTransfersRaw !== undefined &&
        (!Number.isInteger(maxTransfersRaw) || maxTransfersRaw < 0 || maxTransfersRaw > 8)
      ) {
        reply.status(400).send({ error: "max_transfers must be an integer from 0 to 8" });
        return;
      }
      const transferBuffer = q.transfer_buffer ?? "standard";
      if (!["standard", "relaxed", "extra"].includes(transferBuffer)) {
        reply.status(400).send({ error: "transfer_buffer must be standard, relaxed, or extra" });
        return;
      }
      const bikeHillPreference = q.bike_hill_preference ?? "default";
      if (!["default", "avoid", "strongly-avoid"].includes(bikeHillPreference)) {
        reply.status(400).send({ error: "invalid bike_hill_preference" });
        return;
      }
      const rentalFormFactors = parseBoundedList(q.rental_form_factors, RENTAL_FORM_FACTORS);
      const rentalProviderIds = parseBoundedList(q.rental_provider_ids);
      const rentalGroupIds = parseBoundedList(q.rental_group_ids);
      const hasRentalSelection =
        rentalFormFactors.length > 0 || rentalProviderIds.length > 0 || rentalGroupIds.length > 0;
      const hasRentalMode = [q.pre_modes, q.post_modes, q.direct_modes].some((modes) =>
        (modes ?? "").split(",").includes("RENTAL"),
      );
      if (hasRentalSelection && !hasRentalMode) {
        reply.status(400).send({ error: "rental filters require an explicit rental access mode" });
        return;
      }
      if (q.require_bike_transport === "true" && rentalFormFactors.includes("CAR")) {
        reply.status(400).send({ error: "bike transport cannot be combined with car share" });
        return;
      }
      if (
        (rentalProviderIds.length > 0 || rentalGroupIds.length > 0) &&
        (!q.rental_source || !q.rental_instance || !q.capability_epoch)
      ) {
        reply.status(400).send({
          error: "provider/group rental filters require source, instance, and capability epoch",
        });
        return;
      }
      const rentalFilter = hasRentalSelection
        ? {
            formFactors: rentalFormFactors as Array<
              "BICYCLE" | "CARGO_BICYCLE" | "SCOOTER_STANDING" | "SCOOTER_SEATED" | "CAR" | "MOPED"
            >,
            providerIds: rentalProviderIds,
            groupIds: rentalGroupIds,
            source: q.rental_source ?? "transit-motis-local",
            instance: q.rental_instance ?? "local",
            datasetEpoch: q.capability_epoch ?? "active",
          }
        : undefined;
      const pageFingerprint = transitRequestFingerprint(q);
      let pageCursor: string | undefined;
      if (q.page_token) {
        try {
          const token = verifyTransitPageToken(
            q.page_token,
            process.env.BETTER_AUTH_SECRET ?? "",
            pageFingerprint,
          );
          if (q.capability_epoch && token.datasetEpoch !== q.capability_epoch) {
            throw new Error("dataset epoch changed");
          }
          pageCursor = token.cursor;
        } catch {
          reply.status(400).send({ error: "Invalid, expired, or stale transit page token" });
          return;
        }
      }
      const planRequest: TripPlanRequest = {
        regionalAlternatives: true,
        from: { lat: fromLat, lng: fromLng },
        to: { lat: toLat, lng: toLng },
        ...(arriveBy ? { arrivalTime: when } : { departureTime: when }),
        numItineraries,
        modes: (q.modes ?? "TRANSIT").split(",").map((m) => m.trim()),
        wheelchairRequired: q.wheelchair === "true",
        maxTransfers: maxTransfersRaw,
        transferBuffer: transferBuffer as "standard" | "relaxed" | "extra",
        requireBikeTransport: q.require_bike_transport === "true",
        bikeHillPreference: bikeHillPreference as "default" | "avoid" | "strongly-avoid",
        rentalFilters: rentalFilter
          ? { direct: rentalFilter, preTransit: rentalFilter, postTransit: rentalFilter }
          : undefined,
        capabilityEpoch: q.capability_epoch,
        pageCursor,
        preTransitModes: parseModes(q.pre_modes),
        postTransitModes: parseModes(q.post_modes),
        directModes: parseModes(q.direct_modes),
        deutschlandticketOnly: q.deutschlandticket === "true",
      };
      let planRes: Awaited<ReturnType<typeof orchestrator.planTrip>>;
      try {
        planRes = await orchestrator.planTrip(planRequest);
      } catch (error) {
        if (error instanceof UnsupportedTransitPlanningCapabilitiesError) {
          reply.status(422).send({
            error: "No transit planner can honor the selected requirements",
            unsupportedCapabilities: error.capabilities,
          });
          return;
        }
        throw error;
      }
      if (!planRes.data) {
        reply.status(503).send({
          error: "Trip planning unavailable — no transit provider could serve this route",
        });
        return;
      }
      const plan = planRes.data;
      if (plan) {
        const secret = process.env.BETTER_AUTH_SECRET ?? "";
        const tokenBase = {
          source: plan.source ?? plan.provider ?? "transit-motis-local",
          instance: plan.instance ?? plan.provider ?? "local",
          datasetEpoch: plan.datasetEpoch ?? q.capability_epoch ?? "active",
          fingerprint: pageFingerprint,
        };
        if (plan.previousPageCursor) {
          plan.previousPageToken = signTransitPageToken(
            { ...tokenBase, cursor: plan.previousPageCursor, direction: "previous" },
            secret,
          );
        }
        if (plan.nextPageCursor) {
          plan.nextPageToken = signTransitPageToken(
            { ...tokenBase, cursor: plan.nextPageCursor, direction: "next" },
            secret,
          );
        }
        delete plan.previousPageCursor;
        delete plan.nextPageCursor;
        if (plan.source === "transit-motis-local" && plan.datasetEpoch) {
          for (const itinerary of plan.itineraries) {
            itinerary.refreshToken = await issueRefreshToken(
              itinerary,
              "transit-motis-local",
              plan.instance ?? "ms",
              plan.datasetEpoch,
              pageFingerprint,
              planRequest,
            );
          }
        }
      }
      reply.send(toEnvelope(planRes));
    },
    { rateLimitTier: "expensive" },
  );

  // A provider reference is a distinct lookup, never an ordinary search-cache result.
  ctx.registerRoute("POST", "/plan/resolve", async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    try {
      const request = parseTripReferenceRequest(req.body);
      const result = await orchestrator.resolveTrip(request);
      if (!result.data) {
        reply.status(404).send({ error: "The exact provider trip could not be resolved" });
        return;
      }
      if (result.data.source === "transit-motis-local" && result.data.datasetEpoch) {
        for (const itinerary of result.data.itineraries)
          itinerary.refreshToken = await issueReferenceRefreshToken(itinerary, request);
      }
      reply.send(toEnvelope(result));
    } catch (error) {
      if (error instanceof TripReferenceValidationError)
        reply.status(400).send({ error: error.message });
      else if (error instanceof TripReferenceEpochError)
        reply.status(409).send({ error: "Trip reference epoch changed" });
      else if (error instanceof TripReferenceUnsupportedError)
        reply.status(501).send({ error: "Exact trip reconstruction is unsupported" });
      else if (error instanceof TripReferenceUnavailableError)
        reply.status(503).send({ error: "Exact trip source unavailable" });
      else throw error;
    }
  });

  /**
   * POST /plan/chain — a multi-stop transit trip planned around per-waypoint
   * time windows and dwell. One `planTrip` call per segment; no paging, since a
   * chain has no single cursor.
   */
  ctx.registerRoute("POST", "/plan/chain", async (req, reply) => {
    let request: ReturnType<typeof parseChainRequest>;
    try {
      request = parseChainRequest(req.body);
    } catch (error) {
      if (!(error instanceof ChainRequestValidationError)) throw error;
      reply.status(400).send({ error: error.message });
      return;
    }

    // Read the temporal contract from a provider that actually declared it can
    // serve a chain segment; the default covers a provider that declared none.
    const chainProvider = orchestrator
      .collectProviders()
      .find((provider) => provider.capabilities.planningFeatures?.chaining === true);
    const capabilities =
      chainProvider?.capabilities.planningFeatures?.temporal ?? TIME_AWARE_TEMPORAL_DEFAULT;

    try {
      const plan = await planTransitChain({
        waypoints: request.waypoints,
        schedules: request.schedules,
        anchor: request.anchor,
        baseRequest: request.baseRequest,
        planTrip: (segmentRequest) =>
          orchestrator.planTrip(segmentRequest, request.waypoints.length),
        capabilities,
        numItinerariesPerSegment: request.numItineraries,
      });
      reply.header("Cache-Control", "private, max-age=30");
      reply.send(plan);
    } catch (error) {
      if (error instanceof UnsupportedTransitPlanningCapabilitiesError) {
        reply.status(422).send({
          error: "No transit planner can honor the selected requirements",
          unsupportedCapabilities: error.capabilities,
        });
        return;
      }
      throw error;
    }
  });

  function refreshSourceIds(
    providerId: string | undefined,
    tripIds: readonly string[] = [],
  ): string[] {
    return ctx.getIntegrationsByDomain("transit").flatMap((integration) => {
      const providers = (integration.providers.get("transit") ?? []) as TransitProvider[];
      const matches = providers.some((p) =>
        providerId ? p.id === providerId : tripIds.some((id) => id.startsWith(p.prefix)),
      );
      return matches
        ? (integration.manifest.dataSources ?? []).map((source) => source.sourceId)
        : [];
    });
  }

  const replayRefresh = createRefreshReplay(ctx);

  // POST /plan/refresh — opaque, one-time, server-side-bound MOTIS refresh.
  ctx.registerRoute("POST", "/plan/refresh", async (req, reply) => {
    const body = req.body as { token?: unknown } | null;
    if (typeof body?.token !== "string") {
      reply.status(400).send({ error: "Required: token" });
      return;
    }
    let handle: { id: string };
    try {
      handle = verifyRefreshHandle(body.token, refreshSecret);
    } catch {
      reply.status(400).send({ error: "Invalid or expired itinerary refresh token" });
      return;
    }
    const result = await replayRefresh(handle.id, async () => {
      const state = await ctx.cache.get<RefreshState | ReferenceRefreshState>(
        `transit-refresh:${handle.id}`,
      );
      if (!state) return { status: 409, body: { error: "Itinerary refresh state expired" } };
      if (state.kind === "reference") {
        try {
          // Keep imported exact trips bound to their reference; never search for a replacement.
          const sourceIds = refreshSourceIds(
            undefined,
            state.request.reference.legs.map((leg) => leg.tripId),
          );
          const exact = await orchestrator.resolveTrip(state.request);
          const itinerary = exact.data?.itineraries[0];
          if (!itinerary)
            return { status: 409, body: { error: "The exact trip can no longer be refreshed" } };
          itinerary.refreshToken = await issueReferenceRefreshToken(itinerary, state.request);
          return {
            status: 200,
            sourceIds,
            body: envelope(
              { itinerary, fallbackOccurred: false },
              exact.attributions,
              exact.freshness,
            ),
          };
        } catch (error) {
          if (error instanceof TripReferenceUnavailableError)
            return {
              status: 503,
              body: { error: "Exact trip source unavailable", retryable: true },
            };
          if (
            error instanceof TripReferenceEpochError ||
            error instanceof TripReferenceUnsupportedError ||
            error instanceof TripReferenceValidationError
          )
            return { status: 409, body: { error: "The exact trip can no longer be refreshed" } };
          throw error;
        }
      }
      let sourceIds = refreshSourceIds(state.providerId);
      const outcome = await orchestrator.refreshTrip(state.providerId, {
        itineraryId: state.itineraryId,
        datasetEpoch: state.datasetEpoch,
        modes: state.request.modes,
        wheelchairRequired: state.request.wheelchairRequired,
        requireBikeTransport: state.request.requireBikeTransport,
        detailedTransfers: true,
      });
      if (outcome.status === "unavailable")
        return {
          status: 503,
          body: { error: "Itinerary refresh temporarily unavailable", retryable: true },
        };
      const refreshed = outcome.result;
      let itinerary = refreshed.data;
      let fallbackOccurred = false;
      let resultAttributions = refreshed.attributions;
      let resultFreshness = refreshed.freshness;
      if (!itinerary) {
        fallbackOccurred = true;
        const fallback = await orchestrator.planTrip({
          ...state.request,
          regionalAlternatives: false,
          pageCursor: undefined,
        });
        itinerary = fallback.data?.itineraries[0] ?? null;
        resultAttributions = fallback.attributions;
        resultFreshness = fallback.freshness;
      }
      if (!itinerary)
        return {
          status: 409,
          body: { error: "Itinerary can no longer be refreshed or replanned" },
        };
      if (fallbackOccurred)
        sourceIds = refreshSourceIds(
          undefined,
          itinerary.legs.flatMap((leg) => (leg.tripId ? [leg.tripId] : [])),
        );
      if (itinerary.source === "transit-motis-local") {
        itinerary.refreshToken = await issueRefreshToken(
          itinerary,
          state.providerId,
          state.instance,
          itinerary.datasetEpoch ?? state.datasetEpoch,
          state.requestFingerprint,
          state.request,
        );
      }
      return {
        status: 200,
        sourceIds,
        body: envelope({ itinerary, fallbackOccurred }, resultAttributions, resultFreshness),
      };
    });
    reply.header("Cache-Control", "no-store");
    if (result.status === 503) reply.header("Retry-After", "2");
    reply.status(result.status).send(result.body);
  });

  ctx.registerRoute("GET", "/reachability/capabilities", async (_req, reply) => {
    const startedAt = Date.now();
    const capabilities = await orchestrator.getReachabilityCapabilities();
    if (!capabilities) {
      ctx.metricsRecorder?.recordTransitReachability?.({
        operation: "capabilities",
        source: "none",
        capabilityState: "runtime-unhealthy",
        outcome: "unavailable",
        cacheOutcome: "none",
        errorKind: "unavailable",
        latencyMs: Date.now() - startedAt,
      });
      reply.status(503).send({ error: "Transit reachability is unavailable" });
      return;
    }
    ctx.metricsRecorder?.recordTransitReachability?.({
      operation: "capabilities",
      source:
        capabilities.exactPointCheckReason === "hosted-source" ? "transitous" : "self-hosted-motis",
      capabilityState: capabilities.exactPointCheckReason,
      outcome: "ok",
      cacheOutcome: "none",
      errorKind: "none",
      latencyMs: Date.now() - startedAt,
    });
    reply.header("Cache-Control", "no-store");
    reply.send(capabilities);
  });

  ctx.registerRoute(
    "POST",
    "/reachability/surface",
    async (req, reply) => {
      const startedAt = Date.now();
      let request: TransitReachabilitySurfaceRequest;
      try {
        request = parseTransitReachabilitySurfaceRequest(req.body);
      } catch (error) {
        reply.status(400).send({ error: (error as Error).message });
        return;
      }
      try {
        const capabilities = await orchestrator.getReachabilityCapabilities();
        if (!capabilities?.estimatedSurface) {
          ctx.metricsRecorder?.recordTransitReachability?.({
            operation: "surface",
            source: "none",
            capabilityState: capabilities?.exactPointCheckReason ?? "runtime-unhealthy",
            outcome: "unavailable",
            cacheOutcome: "none",
            errorKind: "unavailable",
            latencyMs: Date.now() - startedAt,
          });
          reply.status(503).send({ error: "Transit reachability is unavailable" });
          return;
        }
        const cacheKey = transitSurfaceCacheKey(request, capabilities.datasetEpoch);
        let cacheMiss = false;
        const result = await ctx.cache.withCache(cacheKey, 300, async () => {
          cacheMiss = true;
          const providerResult = await orchestrator.getReachabilitySurface(request, req.signal);
          return {
            ...providerResult,
            data: thinTransitReachabilitySurface(providerResult.data),
          };
        });
        ctx.metricsRecorder?.recordTransitReachability?.({
          operation: "surface",
          source: result.data.source,
          capabilityState: result.data.capabilities.exactPointCheckReason,
          outcome: "ok",
          cacheOutcome: cacheMiss ? "miss" : "hit",
          errorKind: "none",
          latencyMs: Date.now() - startedAt,
          rawSeedCount: result.data.thinning.originalSeedCount,
          seedCount: result.data.thinning.seedCount,
          gridMetres: result.data.thinning.gridMetres,
        });
        reply.header("Cache-Control", "public, max-age=300");
        reply.send(toEnvelope(result));
      } catch (error) {
        const failure = reachabilityFailure(error, req.signal);
        ctx.metricsRecorder?.recordTransitReachability?.({
          operation: "surface",
          source: "none",
          capabilityState: "runtime-unhealthy",
          ...failure,
          cacheOutcome: "none",
          latencyMs: Date.now() - startedAt,
        });
        reply
          .status(failure.errorKind === "timeout" ? 504 : 502)
          .send({ error: "Transit reachability failed" });
      }
    },
    { rateLimitTier: "expensive" },
  );

  ctx.registerRoute(
    "POST",
    "/reachability/check",
    async (req, reply) => {
      const startedAt = Date.now();
      let request: TransitReachabilityCheckRequest;
      try {
        request = parseTransitReachabilityCheckRequest(req.body);
      } catch (error) {
        reply.status(400).send({ error: (error as Error).message });
        return;
      }
      try {
        const capabilities = await orchestrator.getReachabilityCapabilities();
        if (!capabilities?.exactPointChecks) {
          ctx.metricsRecorder?.recordTransitReachability?.({
            operation: "exact",
            source: capabilities?.exactPointCheckReason === "hosted-source" ? "transitous" : "none",
            capabilityState: capabilities?.exactPointCheckReason ?? "runtime-unhealthy",
            outcome: "unavailable",
            cacheOutcome: "none",
            errorKind: "unavailable",
            latencyMs: Date.now() - startedAt,
            destinationCount: request.destinations.length,
            batchCount: 0,
          });
          reply.status(409).send({
            error: "Exact transit reachability is unavailable",
            reason: capabilities?.exactPointCheckReason ?? "runtime-unhealthy",
          });
          return;
        }
        const cacheKey = transitCheckCacheKey(request, capabilities.datasetEpoch);
        let cacheMiss = false;
        const result = await ctx.cache.withCache(cacheKey, 300, () => {
          cacheMiss = true;
          return orchestrator.checkReachabilityDestinations(request, req.signal);
        });
        ctx.metricsRecorder?.recordTransitReachability?.({
          operation: "exact",
          source: "self-hosted-motis",
          capabilityState: capabilities.exactPointCheckReason,
          outcome: "ok",
          cacheOutcome: cacheMiss ? "miss" : "hit",
          errorKind: "none",
          latencyMs: Date.now() - startedAt,
          destinationCount: request.destinations.length,
          batchCount: Math.ceil(
            request.destinations.length / (capabilities.maxDestinationsPerBatch ?? 1),
          ),
        });
        reply.header("Cache-Control", "private, max-age=0");
        reply.send(toEnvelope(result));
      } catch (error) {
        const failure = reachabilityFailure(error, req.signal);
        ctx.metricsRecorder?.recordTransitReachability?.({
          operation: "exact",
          source: "self-hosted-motis",
          capabilityState: "runtime-unhealthy",
          ...failure,
          cacheOutcome: "none",
          latencyMs: Date.now() - startedAt,
          destinationCount: request.destinations.length,
        });
        if (failure.errorKind === "unsupported" || failure.errorKind === "unavailable") {
          reply.status(409).send({ error: "Exact transit reachability is unavailable" });
          return;
        }
        reply
          .status(failure.errorKind === "timeout" ? 504 : 502)
          .send({ error: "Exact transit check failed" });
      }
    },
    { rateLimitTier: "expensive" },
  );

  ctx.registerRoute(
    "POST",
    "/reachability/isochrone",
    async (req, reply) => {
      const startedAt = Date.now();
      let request: TransitIsochroneRequest;
      try {
        request = parseTransitIsochroneRequest(req.body);
      } catch (error) {
        reply.status(400).send({ error: (error as Error).message });
        return;
      }
      try {
        const capabilities = await orchestrator.getReachabilityCapabilities();
        if (!capabilities?.exportableIsochrones) {
          ctx.metricsRecorder?.recordTransitReachability?.({
            operation: "isochrone",
            source:
              capabilities?.exportableIsochroneReason === "hosted-source" ? "transitous" : "none",
            capabilityState: capabilities?.exportableIsochroneReason ?? "runtime-unhealthy",
            outcome: "unavailable",
            cacheOutcome: "none",
            errorKind: "unavailable",
            latencyMs: Date.now() - startedAt,
          });
          reply.status(409).send({
            error: "Exportable transit isochrones are unavailable",
            reason: capabilities?.exportableIsochroneReason ?? "runtime-unhealthy",
          });
          return;
        }

        // Only the sampled field is cached, under a key that excludes
        // thresholds. Contouring then runs on every request, so changing a
        // threshold re-contours a cached field in milliseconds instead of
        // re-sampling for a minute.
        const { fieldResult, cacheMiss } = await withSingleFlight("transit-isochrone", async () => {
          const cacheKey = transitIsochroneFieldCacheKey(request, capabilities.datasetEpoch);
          let miss = false;
          const cached = await ctx.cache.withCache(cacheKey, 900, () => {
            miss = true;
            return orchestrator.getTransitTravelTimeField(request, req.signal);
          });
          return { fieldResult: cached, cacheMiss: miss };
        });

        const field = fieldResult.data;
        const sampling = samplingFromField(field);
        const data: TransitIsochroneResult = {
          contributors: field.contributors,
          lineageComplete: field.lineageComplete,
          queryTime: request.queryTime,
          source: "self-hosted-motis",
          method: TRANSIT_ISOCHRONE_METHOD,
          accuracy: "sampled",
          datasetEpoch: capabilities.datasetEpoch,
          sampling,
          featureCollection: buildIsochroneFeatureCollection(field, request, {
            source: "self-hosted-motis",
            datasetEpoch: capabilities.datasetEpoch,
            attribution: fieldResult.attributions ?? [],
          }),
        };

        ctx.metricsRecorder?.recordTransitReachability?.({
          operation: "isochrone",
          source: data.source,
          capabilityState: capabilities.exportableIsochroneReason,
          outcome: "ok",
          cacheOutcome: cacheMiss ? "miss" : "hit",
          errorKind: "none",
          latencyMs: Date.now() - startedAt,
          seedCount: sampling.sampleCount,
          batchCount: sampling.batchCount,
          gridMetres: sampling.gridMetres,
        });
        reply.header("Cache-Control", "no-store");
        reply.send(toEnvelope({ ...fieldResult, data }));
      } catch (error) {
        if ((error as Error).message?.includes("already in progress")) {
          ctx.metricsRecorder?.recordTransitReachability?.({
            operation: "isochrone",
            source: "none",
            capabilityState: "available",
            outcome: "unavailable",
            cacheOutcome: "none",
            errorKind: "busy",
            latencyMs: Date.now() - startedAt,
          });
          reply.header("Retry-After", "30");
          reply.status(429).send({ error: "A transit isochrone computation is already running" });
          return;
        }
        const failure = reachabilityFailure(error, req.signal);
        ctx.metricsRecorder?.recordTransitReachability?.({
          operation: "isochrone",
          source: "none",
          capabilityState: "runtime-unhealthy",
          ...failure,
          cacheOutcome: "none",
          latencyMs: Date.now() - startedAt,
        });
        if (failure.errorKind === "unsupported" || failure.errorKind === "unavailable") {
          reply.status(409).send({ error: "Exportable transit isochrones are unavailable" });
          return;
        }
        reply
          .status(failure.errorKind === "timeout" ? 504 : 502)
          .send({ error: "Transit isochrone generation failed" });
      }
    },
    { rateLimitTier: "expensive" },
  );

  // GET /alerts
  ctx.registerRoute("GET", "/alerts", async (req, reply) => {
    const bbox = parseBBox(scalarQueries(req.query));
    if (!bbox) {
      reply.status(400).send({ error: "Invalid or missing bbox params" });
      return;
    }
    reply.header("Cache-Control", "public, max-age=15, s-maxage=15");
    const cacheKey = `transit:alerts:${bbox.join(",")}`;
    // Leave room for the 15 s national feed cache and 15 s HTTP cache.
    const alerts = await ctx.cache.withCache(cacheKey, 30, async () => {
      const res = await orchestrator.getAlerts(bbox);
      return toEnvelope(res);
    });
    reply.send(alerts);
  });

  // GET /vehicles
  ctx.registerRoute("GET", "/vehicles", async (req, reply) => {
    reply.header("Cache-Control", "public, max-age=15, s-maxage=15");
    if (scalarQueries(req.query).route_id) {
      const vehicles = await orchestrator.getVehiclePositions(scalarQueries(req.query).route_id);
      reply.send(toEnvelope(vehicles));
      return;
    }
    const bbox = parseBBox(scalarQueries(req.query));
    if (bbox) {
      const vehicles = await orchestrator.getVehicleRadar(bbox);
      reply.send(toEnvelope(vehicles));
      return;
    }
    reply.status(400).send({
      error: "Provide route_id or valid bbox params (sw_lat, sw_lng, ne_lat, ne_lng)",
    });
  });

  // GET /vehicles/:id
  ctx.registerRoute("GET", "/vehicles/:id", async (req, reply) => {
    const tripId = req.params.id;
    // Repeated `fallback_ids=a&fallback_ids=b`, each id verbatim: an id may
    // itself hold a comma or edge spaces. Empty items are dropped, so a bare
    // `fallback_ids=` reads as absent.
    const nonEmptyFallbackIds = listQuery(req.query, "fallback_ids")?.filter((id) => id !== "");
    const fallbackIds = nonEmptyFallbackIds?.length ? nonEmptyFallbackIds : undefined;
    const cacheKey = `transit:vehicle-journey:${JSON.stringify([tripId, fallbackIds ?? []])}`;
    const env = await ctx.cache.withCache(
      cacheKey,
      30,
      async () => toEnvelope(await orchestrator.getVehicleJourney(tripId, fallbackIds)),
      undefined,
      (journey) => Boolean(journey.data),
    );
    if (!env.data) {
      reply.status(404).send({ error: "Vehicle journey not found" });
      return;
    }
    reply.send(toEnvelope(await orchestrator.enrichJourneyPlatforms(env)));
  });

  // GET /departures/for-place
  ctx.registerRoute("GET", "/departures/for-place", async (req, reply) => {
    const place = parsePlaceQuery(scalarQueries(req.query));
    if (!place) {
      reply.status(400).send({ error: "Required: lat, lng, name" });
      return;
    }
    const minutes = parseMinutes(scalarQueries(req.query).minutes);
    if (!minutes) {
      reply.status(400).send({ error: "Invalid minutes param" });
      return;
    }
    reply.header("Cache-Control", "no-store");
    const result = await placeTransit.getMergedDepartures(place, minutes);
    reply.send(toEnvelope(result));
  });

  // GET /arrivals/for-place
  ctx.registerRoute("GET", "/arrivals/for-place", async (req, reply) => {
    const place = parsePlaceQuery(scalarQueries(req.query));
    if (!place) {
      reply.status(400).send({ error: "Required: lat, lng, name" });
      return;
    }
    const minutes = parseMinutes(scalarQueries(req.query).minutes);
    if (!minutes) {
      reply.status(400).send({ error: "Invalid minutes param" });
      return;
    }
    reply.header("Cache-Control", "no-store");
    const result = await placeTransit.getMergedArrivals(place, minutes);
    reply.send(toEnvelope(result));
  });

  // GET /alerts/for-place
  ctx.registerRoute("GET", "/alerts/for-place", async (req, reply) => {
    const place = parsePlaceQuery(scalarQueries(req.query));
    if (!place) {
      reply.status(400).send({ error: "Required: lat, lng, name" });
      return;
    }
    const result = await placeTransit.getMergedAlerts(place);
    reply.header(
      "Cache-Control",
      cacheControl(result.freshness, "public, max-age=60, s-maxage=60"),
    );
    reply.send(toEnvelope(result));
  });

  // GET /facilities/for-place
  ctx.registerRoute("GET", "/facilities/for-place", async (req, reply) => {
    const place = parsePlaceQuery(scalarQueries(req.query));
    if (!place) {
      reply.status(400).send({ error: "Required: lat, lng, name" });
      return;
    }
    const result = await placeTransit.getMergedFacilities(place);
    reply.header(
      "Cache-Control",
      cacheControl(result.freshness, "public, max-age=86400, s-maxage=86400"),
    );
    reply.send(toEnvelope(result));
  });
}
