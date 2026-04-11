import type { BBox, IntegrationContext } from "@openmapx/core";
import { createTransitOrchestrator, getTransitProviderAttribution } from "./orchestrator.js";
import {
  getLinkedStops,
  getMergedAlerts,
  getMergedArrivals,
  getMergedDepartures,
  getMergedFacilities,
  getMergedRoutes,
  initTransitOrchestrator,
} from "./place-transit.js";

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

function utcDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function utcTime(): string {
  return new Date().toISOString().slice(11, 19);
}

export function setup(ctx: IntegrationContext): void {
  const orchestrator = createTransitOrchestrator(ctx);
  initTransitOrchestrator(ctx, orchestrator);

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
    reply.send(result);
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
    reply.send(result);
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
    reply.send(stops);
  });

  // GET /stops/near-place
  ctx.registerRoute("GET", "/stops/near-place", async (req, reply) => {
    const place = parsePlaceQuery(req.query);
    if (!place) {
      reply.status(400).send({ error: "Required: lat, lng, name" });
      return;
    }
    reply.header("Cache-Control", "public, max-age=86400, s-maxage=86400");
    const result = await getLinkedStops(place.lat, place.lng, place.name, req.query.place_id);
    reply.send(result);
  });

  // GET /stops/:id
  ctx.registerRoute("GET", "/stops/:id", async (req, reply) => {
    const stop = await orchestrator.getStop(decodeURIComponent(req.params.id));
    if (!stop) {
      reply.status(404).send({ error: "Stop not found" });
      return;
    }
    reply.send(stop);
  });

  // GET /stops/:id/platform-stops
  ctx.registerRoute("GET", "/stops/:id/platform-stops", async (req, reply) => {
    reply.header("Cache-Control", "public, max-age=3600, s-maxage=3600");
    const result = await orchestrator.getStopPlatforms(decodeURIComponent(req.params.id));
    reply.send(result);
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
    reply.send(result);
  });

  // GET /stops/:id/departures
  ctx.registerRoute("GET", "/stops/:id/departures", async (req, reply) => {
    const minutes = parseMinutes(req.query.minutes);
    if (!minutes) {
      reply.status(400).send({ error: "Invalid minutes param" });
      return;
    }
    reply.header("Cache-Control", "public, max-age=30, s-maxage=30");
    const result = await orchestrator.getDepartures(decodeURIComponent(req.params.id), minutes);
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
    const result = await orchestrator.getArrivals(decodeURIComponent(req.params.id), minutes);
    reply.send(result);
  });

  // GET /stops/:id/alerts
  ctx.registerRoute("GET", "/stops/:id/alerts", async (req, reply) => {
    reply.header("Cache-Control", "public, max-age=60, s-maxage=60");
    const alerts = await orchestrator.getStopAlerts(decodeURIComponent(req.params.id));
    reply.send(alerts);
  });

  // GET /stops/:id/facilities
  ctx.registerRoute("GET", "/stops/:id/facilities", async (req, reply) => {
    const facilities = await orchestrator.getFacilities(decodeURIComponent(req.params.id));
    reply.send(facilities);
  });

  // GET /routes
  ctx.registerRoute("GET", "/routes", async (req, reply) => {
    if (req.query.stop_id) {
      const routes = await orchestrator.getRoutesForStop(req.query.stop_id);
      reply.send(routes);
      return;
    }
    const bbox = parseBBox(req.query);
    if (!bbox) {
      reply.status(400).send({ error: "Provide stop_id or valid bbox params" });
      return;
    }
    const routes = await orchestrator.getRoutesInBbox(bbox);
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
    const result = await getMergedRoutes(place.lat, place.lng, place.name, req.query.place_id);
    reply.send(result);
  });

  // GET /routes/:id
  ctx.registerRoute("GET", "/routes/:id", async (req, reply) => {
    const route = await orchestrator.getRoute(decodeURIComponent(req.params.id));
    if (!route) {
      reply.status(404).send({ error: "Route not found" });
      return;
    }
    reply.send(route);
  });

  // GET /routes/:id/stops
  ctx.registerRoute("GET", "/routes/:id/stops", async (req, reply) => {
    const hintStopId = req.query.hint_stop_id
      ? decodeURIComponent(req.query.hint_stop_id)
      : undefined;
    const stops = await orchestrator.getRouteStops(decodeURIComponent(req.params.id), hintStopId);
    reply.send(stops);
  });

  // GET /routes/:id/alerts
  ctx.registerRoute("GET", "/routes/:id/alerts", async (req, reply) => {
    reply.header("Cache-Control", "public, max-age=60, s-maxage=60");
    const alerts = await orchestrator.getRouteAlerts(decodeURIComponent(req.params.id));
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
    reply.send({ vehicles, alerts });
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
    const plan = await orchestrator.planTrip({
      from: { lat: fromLat, lng: fromLng },
      to: { lat: toLat, lng: toLng },
      departureTime: `${date}T${time}Z`,
      modes: (q.modes ?? "TRANSIT").split(",").map((m) => m.trim()),
    });
    if (!plan) {
      reply.status(503).send({
        error: "Trip planning unavailable — no transit provider could serve this route",
      });
      return;
    }
    reply.send(plan);
  });

  // GET /reachable
  ctx.registerRoute("GET", "/reachable", async (req, reply) => {
    const lat = Number(req.query.lat);
    const lng = Number(req.query.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      reply.status(400).send({ error: "Required: lat, lng" });
      return;
    }
    const maxTravelTime = Math.min(Number(req.query.maxTravelTime ?? 30), 120);

    const cacheKey = `reachable:${lat.toFixed(3)}:${lng.toFixed(3)}:${maxTravelTime}:${req.query.modes ?? ""}`;
    const results = await ctx.cache.withCache(cacheKey, 300, () =>
      orchestrator.getReachableStops(
        lat,
        lng,
        maxTravelTime,
        req.query.modes?.split(",").map((m) => m.trim()),
      ),
    );
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
    const alerts = await orchestrator.getAlerts(bbox);
    reply.send(alerts);
  });

  // GET /vehicles
  ctx.registerRoute("GET", "/vehicles", async (req, reply) => {
    reply.header("Cache-Control", "public, max-age=15, s-maxage=15");
    if (req.query.route_id) {
      const vehicles = await orchestrator.getVehiclePositions(req.query.route_id);
      reply.send(vehicles);
      return;
    }
    const bbox = parseBBox(req.query);
    if (bbox) {
      const vehicles = await orchestrator.getVehicleRadar(bbox);
      reply.send(vehicles);
      return;
    }
    reply.status(400).send({
      error: "Provide route_id or valid bbox params (sw_lat, sw_lng, ne_lat, ne_lng)",
    });
  });

  // GET /vehicles/:id
  ctx.registerRoute("GET", "/vehicles/:id", async (req, reply) => {
    const fallbackIds = req.query.fallback_ids
      ? req.query.fallback_ids.split(",").map((s) => decodeURIComponent(s.trim()))
      : undefined;
    const journey = await orchestrator.getVehicleJourney(
      decodeURIComponent(req.params.id),
      fallbackIds,
    );
    if (!journey) {
      reply.status(404).send({ error: "Vehicle journey not found" });
      return;
    }
    reply.send(journey);
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
    const result = await getMergedDepartures(
      place.lat,
      place.lng,
      place.name,
      minutes,
      req.query.place_id,
    );
    reply.send(result);
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
    const result = await getMergedArrivals(
      place.lat,
      place.lng,
      place.name,
      minutes,
      req.query.place_id,
    );
    reply.send(result);
  });

  // GET /alerts/for-place
  ctx.registerRoute("GET", "/alerts/for-place", async (req, reply) => {
    const place = parsePlaceQuery(req.query);
    if (!place) {
      reply.status(400).send({ error: "Required: lat, lng, name" });
      return;
    }
    reply.header("Cache-Control", "public, max-age=60, s-maxage=60");
    const result = await getMergedAlerts(place.lat, place.lng, place.name, req.query.place_id);
    reply.send(result);
  });

  // GET /facilities/for-place
  ctx.registerRoute("GET", "/facilities/for-place", async (req, reply) => {
    const place = parsePlaceQuery(req.query);
    if (!place) {
      reply.status(400).send({ error: "Required: lat, lng, name" });
      return;
    }
    reply.header("Cache-Control", "public, max-age=86400, s-maxage=86400");
    const result = await getMergedFacilities(place.lat, place.lng, place.name, req.query.place_id);
    reply.send(result);
  });

  // GET /providers
  ctx.registerRoute("GET", "/providers", async (_req, reply) => {
    reply.header("Cache-Control", "public, max-age=3600, s-maxage=3600");
    const attribution = getTransitProviderAttribution(ctx);
    reply.send(attribution);
  });

  // GET /health
  ctx.registerRoute("GET", "/health", async (_req, reply) => {
    reply.send({ providers: orchestrator.getHealthStatus() });
  });
}
