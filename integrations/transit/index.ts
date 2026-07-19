import { randomUUID } from "node:crypto";
import type { BBox } from "@openmapx/core";
import type { IntegrationContext, TripPlanRequest } from "@openmapx/integration-framework";
import type { Attribution } from "@openmapx/mobility-core/attribution";
import type { Freshness } from "@openmapx/mobility-core/freshness";
import type { MobilityEnvelope, MobilityResult } from "@openmapx/mobility-core/result";
import type { GeoJSONLineString, TripItinerary } from "@openmapx/mobility-core/transit";
import {
  createTransitOrchestrator,
  UnsupportedTransitPlanningCapabilitiesError,
} from "./orchestrator.js";
import {
  signTransitPageToken,
  transitRequestFingerprint,
  verifyTransitPageToken,
} from "./page-token.js";
import { createPlaceTransit } from "./place-transit.js";
import { signRefreshHandle, verifyRefreshHandle } from "./refresh-token.js";

/**
 * Strip the server-only `trace` field from a MobilityResult and return the
 * `{ data, attributions, freshness }` envelope sent on the wire.
 */
function toEnvelope<T>(result: MobilityResult<T>): MobilityEnvelope<T> {
  return {
    data: result.data,
    attributions: result.attributions,
    freshness: result.freshness,
  };
}

/** Build an envelope from raw data + a fresh attribution/freshness pair. */
function envelope<T>(
  data: T,
  attributions: Attribution[],
  freshness: Freshness,
): MobilityEnvelope<T> {
  return { data, attributions, freshness };
}

function parseBBox(q: Record<string, string>): BBox | null {
  const sw_lat = Number(q.sw_lat);
  const sw_lng = Number(q.sw_lng);
  const ne_lat = Number(q.ne_lat);
  const ne_lng = Number(q.ne_lng);
  if (
    !Number.isFinite(sw_lat) ||
    !Number.isFinite(sw_lng) ||
    !Number.isFinite(ne_lat) ||
    !Number.isFinite(ne_lng) ||
    sw_lat >= ne_lat
  ) {
    return null;
  }
  return [sw_lng, sw_lat, ne_lng, ne_lat];
}

function parsePlaceQuery(
  q: Record<string, string>,
): { lat: number; lng: number; name: string } | null {
  const lat = Number(q.lat);
  const lng = Number(q.lng);
  const name = q.name?.trim();
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || !name) return null;
  return { lat, lng, name };
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

function utcTime(): string {
  return new Date().toISOString().slice(11, 19);
}

export function setup(ctx: IntegrationContext): void {
  const orchestrator = createTransitOrchestrator(ctx);
  const refreshSecret = process.env.BETTER_AUTH_SECRET ?? "";
  const refreshTtlSeconds = 15 * 60;

  interface RefreshState {
    providerId: string;
    instance: string;
    datasetEpoch: string;
    requestFingerprint: string;
    itineraryId: string;
    request: TripPlanRequest;
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
  const placeTransit = createPlaceTransit(ctx, orchestrator);

  // GET /stops
  ctx.registerRoute("GET", "/stops", async (req, reply) => {
    const bbox = parseBBox(req.query);
    if (!bbox) {
      reply
        .status(400)
        .send({ error: "Invalid or missing bbox params (sw_lat, sw_lng, ne_lat, ne_lng)" });
      return;
    }
    const result = await orchestrator.getStopsInBbox(bbox, parseModes(req.query.modes));
    reply.send(toEnvelope(result));
  });

  // GET /stops/nearby
  ctx.registerRoute("GET", "/stops/nearby", async (req, reply) => {
    const lat = Number(req.query.lat);
    const lng = Number(req.query.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      reply.status(400).send({ error: "Required: lat, lng" });
      return;
    }
    const radiusMeters = Math.min(Number(req.query.radius ?? 500), 2000);
    const latDelta = radiusMeters / 111_320;
    const lngDelta = radiusMeters / (111_320 * Math.cos((lat * Math.PI) / 180));
    const bbox: BBox = [lng - lngDelta, lat - latDelta, lng + lngDelta, lat + latDelta];
    reply.header("Cache-Control", "public, max-age=300, s-maxage=300");
    const result = await orchestrator.getStopsInBbox(bbox, parseModes(req.query.modes));
    reply.send(toEnvelope(result));
  });

  // GET /stops/search
  ctx.registerRoute("GET", "/stops/search", async (req, reply) => {
    const query = req.query.q?.trim();
    if (!query || query.length < 2) {
      reply.status(400).send({ error: "Query parameter 'q' must be at least 2 characters" });
      return;
    }
    const limit = Math.min(Math.max(Number(req.query.limit) || 5, 1), 20);
    reply.header("Cache-Control", "public, max-age=300, s-maxage=300");
    const stops = await orchestrator.searchByName(query, limit);
    reply.send(toEnvelope(stops));
  });

  // GET /stops/near-place
  ctx.registerRoute("GET", "/stops/near-place", async (req, reply) => {
    const place = parsePlaceQuery(req.query);
    if (!place) {
      reply.status(400).send({ error: "Required: lat, lng, name" });
      return;
    }
    reply.header("Cache-Control", "public, max-age=86400, s-maxage=86400");
    const result = await placeTransit.getLinkedStops(
      place.lat,
      place.lng,
      place.name,
      req.query.place_id,
    );
    reply.send(toEnvelope(result));
  });

  // GET /stops/:id
  ctx.registerRoute("GET", "/stops/:id", async (req, reply) => {
    const res = await orchestrator.getStop(decodeURIComponent(req.params.id));
    if (!res.data) {
      reply.status(404).send({ error: "Stop not found" });
      return;
    }
    reply.send(toEnvelope(res));
  });

  // GET /stops/:id/transfers — accessibility-annotated transfers out of a stop.
  ctx.registerRoute("GET", "/stops/:id/transfers", async (req, reply) => {
    const stopId = decodeURIComponent(req.params.id);
    const cacheKey = `stop-transfers:${stopId}`;
    let env = (await ctx.cache.get(cacheKey)) as MobilityEnvelope<unknown> | null;
    if (!env) {
      const res = await orchestrator.getStopTransfers(stopId);
      env = toEnvelope(res);
      await ctx.cache.set(cacheKey, env, 3600);
    }
    reply.header("Cache-Control", "public, max-age=600, s-maxage=3600");
    reply.send(env);
  });

  // GET /stops/:id/infrastructure
  ctx.registerRoute("GET", "/stops/:id/infrastructure", async (req, reply) => {
    const stopId = decodeURIComponent(req.params.id);
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

  // GET /stops/:id/platform-stops
  ctx.registerRoute("GET", "/stops/:id/platform-stops", async (req, reply) => {
    reply.header("Cache-Control", "public, max-age=3600, s-maxage=3600");
    const result = await orchestrator.getStopPlatforms(decodeURIComponent(req.params.id));
    reply.send(toEnvelope(result));
  });

  // GET /stops/:id/timetable
  ctx.registerRoute("GET", "/stops/:id/timetable", async (req, reply) => {
    const date = req.query.date ?? utcDate();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      reply.status(400).send({ error: "Invalid date format. Use YYYY-MM-DD." });
      return;
    }
    const isPast = date < utcDate();
    reply.header(
      "Cache-Control",
      isPast ? "public, max-age=86400, s-maxage=86400" : "public, max-age=300, s-maxage=300",
    );
    const result = await orchestrator.getStopTimetable(decodeURIComponent(req.params.id), date);
    reply.send(toEnvelope(result));
  });

  // GET /stops/:id/departures
  ctx.registerRoute("GET", "/stops/:id/departures", async (req, reply) => {
    const minutes = parseMinutes(req.query.minutes);
    if (!minutes) {
      reply.status(400).send({ error: "Invalid minutes param" });
      return;
    }
    reply.header("Cache-Control", "public, max-age=30, s-maxage=30");
    const stopId = decodeURIComponent(req.params.id);
    const cacheKey = `transit:departures:${stopId}:${minutes}`;
    const result = await ctx.cache.withCache(cacheKey, 30, async () => {
      const res = await orchestrator.getDepartures(stopId, minutes);
      return toEnvelope(res);
    });
    reply.send(result);
  });

  // GET /stops/:id/arrivals
  ctx.registerRoute("GET", "/stops/:id/arrivals", async (req, reply) => {
    const minutes = parseMinutes(req.query.minutes);
    if (!minutes) {
      reply.status(400).send({ error: "Invalid minutes param" });
      return;
    }
    reply.header("Cache-Control", "public, max-age=60, s-maxage=60");
    const stopId = decodeURIComponent(req.params.id);
    const cacheKey = `transit:arrivals:${stopId}:${minutes}`;
    const result = await ctx.cache.withCache(cacheKey, 60, async () => {
      const res = await orchestrator.getArrivals(stopId, minutes);
      return toEnvelope(res);
    });
    reply.send(result);
  });

  // GET /stops/:id/alerts
  ctx.registerRoute("GET", "/stops/:id/alerts", async (req, reply) => {
    reply.header("Cache-Control", "public, max-age=60, s-maxage=60");
    const stopId = decodeURIComponent(req.params.id);
    const cacheKey = `transit:stop-alerts:${stopId}`;
    const alerts = await ctx.cache.withCache(cacheKey, 60, async () => {
      const res = await orchestrator.getStopAlerts(stopId);
      return toEnvelope(res);
    });
    reply.send(alerts);
  });

  // GET /stops/:id/facilities
  ctx.registerRoute("GET", "/stops/:id/facilities", async (req, reply) => {
    const result = await orchestrator.getFacilities(decodeURIComponent(req.params.id));
    reply.send(toEnvelope(result));
  });

  // GET /routes
  ctx.registerRoute("GET", "/routes", async (req, reply) => {
    if (req.query.stop_id) {
      const stopId = decodeURIComponent(req.query.stop_id);
      const cacheKey = `transit:routes-for-stop:${stopId}`;
      const routes = await ctx.cache.withCache(cacheKey, 300, async () => {
        const res = await orchestrator.getRoutesForStop(stopId);
        return toEnvelope(res);
      });
      reply.send(routes);
      return;
    }
    const bbox = parseBBox(req.query);
    if (!bbox) {
      reply.status(400).send({ error: "Provide stop_id or valid bbox params" });
      return;
    }
    // The network overlay refetches on every moveend (and on style/theme
    // changes), so cache by a coarsened bbox (~110m) to collapse near-identical
    // viewports onto one upstream MOTIS call instead of hammering the always-on
    // cloud instance.
    reply.header("Cache-Control", "public, max-age=120, s-maxage=120");
    const zoom = routeZoomBucket(req.query.zoom);
    const cacheKey = `transit:routes-bbox:${zoom}:${bbox.map((n) => n.toFixed(3)).join(",")}`;
    const routes = await ctx.cache.withCache(cacheKey, 120, async () => {
      const res = await orchestrator.getRoutesInBbox(bbox, zoom);
      return toEnvelope(res);
    });
    reply.send(routes);
  });

  // GET /routes/for-place
  ctx.registerRoute("GET", "/routes/for-place", async (req, reply) => {
    const place = parsePlaceQuery(req.query);
    if (!place) {
      reply.status(400).send({ error: "Required: lat, lng, name" });
      return;
    }
    reply.header("Cache-Control", "public, max-age=300, s-maxage=300");
    const result = await placeTransit.getMergedRoutes(
      place.lat,
      place.lng,
      place.name,
      req.query.place_id,
    );
    reply.send(toEnvelope(result));
  });

  // GET /routes/:id
  ctx.registerRoute("GET", "/routes/:id", async (req, reply) => {
    const routeId = decodeURIComponent(req.params.id);
    const cacheKey = `transit:route:${routeId}`;
    let env = (await ctx.cache.get(cacheKey)) as MobilityEnvelope<unknown> | null;
    if (!env) {
      const res = await orchestrator.getRoute(routeId);
      if (res.data) {
        env = toEnvelope(res);
        await ctx.cache.set(cacheKey, env, 3600);
      }
    }
    if (!env?.data) {
      reply.status(404).send({ error: "Route not found" });
      return;
    }
    reply.send(env);
  });

  // GET /routes/:id/stops
  ctx.registerRoute("GET", "/routes/:id/stops", async (req, reply) => {
    const routeId = decodeURIComponent(req.params.id);
    const hintStopId = req.query.hint_stop_id
      ? decodeURIComponent(req.query.hint_stop_id)
      : undefined;
    const cacheKey = `transit:route-stops:${routeId}:${hintStopId ?? ""}`;
    let env = (await ctx.cache.get(cacheKey)) as MobilityEnvelope<unknown[]> | null;
    if (!env) {
      const res = await orchestrator.getRouteStops(routeId, hintStopId);
      env = toEnvelope(res) as MobilityEnvelope<unknown[]>;
      if (Array.isArray(env.data) && env.data.length > 0) {
        await ctx.cache.set(cacheKey, env, 3600);
      }
    }
    reply.send(env);
  });

  // GET /routes/:id/alerts
  ctx.registerRoute("GET", "/routes/:id/alerts", async (req, reply) => {
    reply.header("Cache-Control", "public, max-age=60, s-maxage=60");
    const routeId = decodeURIComponent(req.params.id);
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
    const routeId = decodeURIComponent(req.params.id);
    const [vehicles, alerts] = await Promise.all([
      orchestrator.getVehiclePositions(routeId),
      orchestrator.getRouteAlerts(routeId),
    ]);
    const seen = new Set<string>();
    const mergedAttrs: Attribution[] = [];
    for (const a of [...vehicles.attributions, ...alerts.attributions]) {
      if (seen.has(a.sourceId)) continue;
      seen.add(a.sourceId);
      mergedAttrs.push(a);
    }
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
    const tripId = req.query.trip_id?.trim();
    if (!tripId) {
      reply.status(400).send({ error: "Required: trip_id" });
      return;
    }
    const fromStopId = req.query.from_stop_id?.trim() || undefined;
    const toStopId = req.query.to_stop_id?.trim() || undefined;
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
  ctx.registerRoute("GET", "/plan", async (req, reply) => {
    const q = req.query;
    const fromLat = Number(q.from_lat);
    const fromLng = Number(q.from_lng);
    const toLat = Number(q.to_lat);
    const toLng = Number(q.to_lng);
    if (
      !Number.isFinite(fromLat) ||
      !Number.isFinite(fromLng) ||
      !Number.isFinite(toLat) ||
      !Number.isFinite(toLng)
    ) {
      reply.status(400).send({
        error: "Invalid or missing coordinate params (from_lat, from_lng, to_lat, to_lng)",
      });
      return;
    }
    reply.header("Cache-Control", "private, max-age=60");
    let date: string;
    let time: string;
    if (q.time?.includes("T")) {
      const d = new Date(q.time);
      date = d.toISOString().slice(0, 10);
      time = d.toISOString().slice(11, 19);
    } else {
      date = q.date ?? utcDate();
      time = q.time ? (q.time.split(":").length >= 3 ? q.time : `${q.time}:00`) : utcTime();
    }
    // `time` is an arrival deadline when arrive_by is set, otherwise a departure.
    const arriveBy = q.arrive_by === "true";
    const when = `${date}T${time}Z`;
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
      from: { lat: fromLat, lng: fromLng },
      to: { lat: toLat, lng: toLng },
      ...(arriveBy ? { arrivalTime: when } : { departureTime: when }),
      numItineraries,
      modes: (q.modes ?? "TRANSIT").split(",").map((m) => m.trim()),
      wheelchair: q.wheelchair === "true",
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
  });

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
    const cacheKey = `transit-refresh:${handle.id}`;
    const state = await ctx.cache.get<RefreshState>(cacheKey);
    if (!state) {
      reply.status(409).send({ error: "Itinerary refresh state expired" });
      return;
    }
    await ctx.cache.del(cacheKey);

    const refreshed = await orchestrator.refreshTrip(state.providerId, {
      itineraryId: state.itineraryId,
      datasetEpoch: state.datasetEpoch,
      modes: state.request.modes,
      wheelchairRequired: state.request.wheelchairRequired,
      requireBikeTransport: state.request.requireBikeTransport,
      detailedTransfers: true,
    });
    let itinerary = refreshed.data;
    let fallbackOccurred = false;
    let resultAttributions = refreshed.attributions;
    let resultFreshness = refreshed.freshness;

    if (!itinerary) {
      fallbackOccurred = true;
      const fallback = await orchestrator.planTrip({ ...state.request, pageCursor: undefined });
      itinerary = fallback.data?.itineraries[0] ?? null;
      resultAttributions = fallback.attributions;
      resultFreshness = fallback.freshness;
    }
    if (!itinerary) {
      reply.status(409).send({ error: "Itinerary can no longer be refreshed or replanned" });
      return;
    }
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
    reply.send(envelope({ itinerary, fallbackOccurred }, resultAttributions, resultFreshness));
  });

  // GET /reachable
  ctx.registerRoute("GET", "/reachable", async (req, reply) => {
    const lat = Number(req.query.lat);
    const lng = Number(req.query.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      reply.status(400).send({ error: "Required: lat, lng" });
      return;
    }
    const maxRaw = Number(req.query.maxTravelTime ?? 30);
    const maxTravelTime = Number.isFinite(maxRaw) ? Math.min(Math.max(maxRaw, 1), 120) : 30;

    const cacheKey = `reachable:${lat.toFixed(3)}:${lng.toFixed(3)}:${maxTravelTime}:${req.query.modes ?? ""}`;
    const results = await ctx.cache.withCache(cacheKey, 300, async () => {
      const res = await orchestrator.getReachableStops(
        lat,
        lng,
        maxTravelTime,
        req.query.modes?.split(",").map((m) => m.trim()),
      );
      return toEnvelope(res);
    });
    reply.header("Cache-Control", "public, max-age=300");
    reply.send(results);
  });

  // GET /alerts
  ctx.registerRoute("GET", "/alerts", async (req, reply) => {
    const bbox = parseBBox(req.query);
    if (!bbox) {
      reply.status(400).send({ error: "Invalid or missing bbox params" });
      return;
    }
    reply.header("Cache-Control", "public, max-age=60, s-maxage=60");
    const cacheKey = `transit:alerts:${bbox.join(",")}`;
    const alerts = await ctx.cache.withCache(cacheKey, 60, async () => {
      const res = await orchestrator.getAlerts(bbox);
      return toEnvelope(res);
    });
    reply.send(alerts);
  });

  // GET /vehicles
  ctx.registerRoute("GET", "/vehicles", async (req, reply) => {
    reply.header("Cache-Control", "public, max-age=15, s-maxage=15");
    if (req.query.route_id) {
      const vehicles = await orchestrator.getVehiclePositions(req.query.route_id);
      reply.send(toEnvelope(vehicles));
      return;
    }
    const bbox = parseBBox(req.query);
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
    const tripId = decodeURIComponent(req.params.id);
    const fallbackIds = req.query.fallback_ids
      ? req.query.fallback_ids.split(",").map((s) => decodeURIComponent(s.trim()))
      : undefined;
    const cacheKey = `transit:vehicle-journey:${tripId}:${(fallbackIds ?? []).join(",")}`;
    let env = (await ctx.cache.get(cacheKey)) as MobilityEnvelope<unknown> | null;
    if (!env) {
      const res = await orchestrator.getVehicleJourney(tripId, fallbackIds);
      if (res.data) {
        env = toEnvelope(res);
        await ctx.cache.set(cacheKey, env, 30);
      }
    }
    if (!env?.data) {
      reply.status(404).send({ error: "Vehicle journey not found" });
      return;
    }
    reply.send(env);
  });

  // GET /departures/for-place
  ctx.registerRoute("GET", "/departures/for-place", async (req, reply) => {
    const place = parsePlaceQuery(req.query);
    if (!place) {
      reply.status(400).send({ error: "Required: lat, lng, name" });
      return;
    }
    const minutes = parseMinutes(req.query.minutes);
    if (!minutes) {
      reply.status(400).send({ error: "Invalid minutes param" });
      return;
    }
    reply.header("Cache-Control", "no-store");
    const result = await placeTransit.getMergedDepartures(
      place.lat,
      place.lng,
      place.name,
      minutes,
      req.query.place_id,
    );
    reply.send(toEnvelope(result));
  });

  // GET /arrivals/for-place
  ctx.registerRoute("GET", "/arrivals/for-place", async (req, reply) => {
    const place = parsePlaceQuery(req.query);
    if (!place) {
      reply.status(400).send({ error: "Required: lat, lng, name" });
      return;
    }
    const minutes = parseMinutes(req.query.minutes);
    if (!minutes) {
      reply.status(400).send({ error: "Invalid minutes param" });
      return;
    }
    reply.header("Cache-Control", "no-store");
    const result = await placeTransit.getMergedArrivals(
      place.lat,
      place.lng,
      place.name,
      minutes,
      req.query.place_id,
    );
    reply.send(toEnvelope(result));
  });

  // GET /alerts/for-place
  ctx.registerRoute("GET", "/alerts/for-place", async (req, reply) => {
    const place = parsePlaceQuery(req.query);
    if (!place) {
      reply.status(400).send({ error: "Required: lat, lng, name" });
      return;
    }
    reply.header("Cache-Control", "public, max-age=60, s-maxage=60");
    const result = await placeTransit.getMergedAlerts(
      place.lat,
      place.lng,
      place.name,
      req.query.place_id,
    );
    reply.send(toEnvelope(result));
  });

  // GET /facilities/for-place
  ctx.registerRoute("GET", "/facilities/for-place", async (req, reply) => {
    const place = parsePlaceQuery(req.query);
    if (!place) {
      reply.status(400).send({ error: "Required: lat, lng, name" });
      return;
    }
    reply.header("Cache-Control", "public, max-age=86400, s-maxage=86400");
    const result = await placeTransit.getMergedFacilities(
      place.lat,
      place.lng,
      place.name,
      req.query.place_id,
    );
    reply.send(toEnvelope(result));
  });
}
