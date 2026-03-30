import type { FastifyInstance } from "fastify";
import { transitOrchestrator } from "../services/transit/orchestrator";
import {
  getLinkedStops,
  getMergedAlerts,
  getMergedArrivals,
  getMergedDepartures,
  getMergedFacilities,
  getMergedRoutes,
} from "../services/transit/place-transit";
import { registry } from "../services/transit/registry/index";
import { STATIC_PROVIDER_ATTRIBUTION } from "../services/transit/static-providers";
import type { BBox, TransportMode } from "../services/transit/types";
import { hashKey, withCache } from "../utils/cache";
import { getFeedProviders } from "./transit-attribution";

interface BBoxQuery {
  sw_lat: string;
  sw_lng: string;
  ne_lat: string;
  ne_lng: string;
}

function parseBBox(q: BBoxQuery): BBox | null {
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

/** Returns current UTC date as YYYY-MM-DD. */
function utcDate(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Returns current UTC time as HH:MM:SS. */
function utcTime(): string {
  return new Date().toISOString().slice(11, 19);
}

/** Shared schema fragments */

const bboxProperties = {
  sw_lat: { type: "string" },
  sw_lng: { type: "string" },
  ne_lat: { type: "string" },
  ne_lng: { type: "string" },
} as const;

const bboxRequired = ["sw_lat", "sw_lng", "ne_lat", "ne_lng"] as const;

const idParamSchema = {
  type: "object",
  required: ["id"],
  properties: { id: { type: "string" } },
} as const;

/** Querystring type interfaces */

interface StopsQuery extends BBoxQuery {
  modes?: string;
}

interface NearbyQuery {
  lat: string;
  lng: string;
  radius?: string;
  modes?: string;
}

interface StopSearchQuery {
  q: string;
  limit?: string;
}

interface PlaceQuery {
  lat: string;
  lng: string;
  name: string;
  place_id?: string;
}

interface PlaceMinutesQuery extends PlaceQuery {
  minutes?: string;
}

interface TimetableQuery {
  date?: string;
}

interface MinutesQuery {
  minutes?: string;
}

interface RoutesQuery extends Partial<BBoxQuery> {
  stop_id?: string;
}

interface VehiclesQuery extends Partial<BBoxQuery> {
  route_id?: string;
}

interface VehicleByIdQuery {
  fallback_ids?: string;
}

interface RouteStopsQuery {
  hint_stop_id?: string;
}

interface PlanQuery {
  from_lat: string;
  from_lng: string;
  to_lat: string;
  to_lng: string;
  time?: string;
  date?: string;
  modes?: string;
  num_itineraries?: string;
  arrive_by?: string;
  lang?: string;
}

/** Route registration */

export async function transitRoute(server: FastifyInstance): Promise<void> {
  // Shared error handler for transit service calls
  server.setErrorHandler(async (error: Error & { statusCode?: number }, _request, reply) => {
    const statusCode = error.statusCode ?? 500;
    const message = statusCode >= 500 ? "Internal transit service error" : error.message;
    return reply.status(statusCode).send({ error: message });
  });

  // GET /api/transit/stops
  server.get<{ Querystring: StopsQuery }>("/transit/stops", {
    schema: {
      querystring: {
        type: "object",
        required: [...bboxRequired],
        properties: {
          ...bboxProperties,
          modes: { type: "string" },
        },
      },
    },
    handler: async (req, reply) => {
      const q = req.query;
      const bbox = parseBBox(q);
      if (!bbox) {
        return reply
          .status(400)
          .send({ error: "Invalid or missing bbox params (sw_lat, sw_lng, ne_lat, ne_lng)" });
      }
      const modes = q.modes
        ? (String(q.modes)
            .split(",")
            .map((m) => m.trim()) as TransportMode[])
        : undefined;
      const stops = await transitOrchestrator.getStopsInBbox(bbox, modes);
      return stops;
    },
  });

  // GET /api/transit/stops/nearby?lat=&lng=&radius=500&modes=
  server.get<{ Querystring: NearbyQuery }>("/transit/stops/nearby", {
    schema: {
      querystring: {
        type: "object",
        required: ["lat", "lng"],
        properties: {
          lat: { type: "string" },
          lng: { type: "string" },
          radius: { type: "string" },
          modes: { type: "string" },
        },
      },
    },
    handler: async (req, reply) => {
      const q = req.query;
      const lat = Number(q.lat);
      const lng = Number(q.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        return reply.status(400).send({ error: "Required: lat, lng" });
      }
      const radiusMeters = Math.min(Number(q.radius ?? 500), 2000);
      // Convert lat/lng + radius to a bbox (rough approximation, ~1m precision at all latitudes)
      const latDelta = radiusMeters / 111_320;
      const lngDelta = radiusMeters / (111_320 * Math.cos((lat * Math.PI) / 180));
      const bbox: BBox = [lng - lngDelta, lat - latDelta, lng + lngDelta, lat + latDelta];
      const modes = q.modes
        ? (String(q.modes)
            .split(",")
            .map((m) => m.trim()) as TransportMode[])
        : undefined;
      reply.header("Cache-Control", "public, max-age=300, s-maxage=300");
      const stops = await transitOrchestrator.getStopsInBbox(bbox, modes);
      return stops;
    },
  });

  // GET /api/transit/stops/search?q=<name>&limit=3
  server.get<{ Querystring: StopSearchQuery }>("/transit/stops/search", {
    schema: {
      querystring: {
        type: "object",
        required: ["q"],
        properties: {
          q: { type: "string", minLength: 2 },
          limit: { type: "string" },
        },
      },
    },
    handler: async (req, reply) => {
      const q = req.query;
      const query = q.q?.trim();
      if (!query || query.length < 2) {
        return reply
          .status(400)
          .send({ error: "Query parameter 'q' must be at least 2 characters" });
      }
      const limit = Math.min(Math.max(Number(q.limit) || 5, 1), 20);
      reply.header("Cache-Control", "public, max-age=300, s-maxage=300");
      const stops = await transitOrchestrator.searchByName(query, limit);
      return stops;
    },
  });

  // GET /api/transit/stops/near-place?lat=&lng=&name=&place_id=
  server.get<{ Querystring: PlaceQuery }>("/transit/stops/near-place", {
    schema: {
      querystring: {
        type: "object",
        required: ["lat", "lng", "name"],
        properties: {
          lat: { type: "string" },
          lng: { type: "string" },
          name: { type: "string" },
          place_id: { type: "string" },
        },
      },
    },
    handler: async (req, reply) => {
      const q = req.query;
      const lat = Number(q.lat);
      const lng = Number(q.lng);
      const name = q.name?.trim();
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || !name) {
        return reply.status(400).send({ error: "Required: lat, lng, name" });
      }
      // Cached 24h server-side
      reply.header("Cache-Control", "public, max-age=86400, s-maxage=86400");
      return getLinkedStops(lat, lng, name, q.place_id);
    },
  });

  // GET /api/transit/routes/for-place?lat=&lng=&name=&place_id=
  server.get<{ Querystring: PlaceQuery }>("/transit/routes/for-place", {
    schema: {
      querystring: {
        type: "object",
        required: ["lat", "lng", "name"],
        properties: {
          lat: { type: "string" },
          lng: { type: "string" },
          name: { type: "string" },
          place_id: { type: "string" },
        },
      },
    },
    handler: async (req, reply) => {
      const q = req.query;
      const lat = Number(q.lat);
      const lng = Number(q.lng);
      const name = q.name?.trim();
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || !name) {
        return reply.status(400).send({ error: "Required: lat, lng, name" });
      }
      reply.header("Cache-Control", "public, max-age=300, s-maxage=300");
      return getMergedRoutes(lat, lng, name, q.place_id);
    },
  });

  // GET /api/transit/departures/for-place?lat=&lng=&name=&minutes=60&place_id=
  server.get<{ Querystring: PlaceMinutesQuery }>("/transit/departures/for-place", {
    schema: {
      querystring: {
        type: "object",
        required: ["lat", "lng", "name"],
        properties: {
          lat: { type: "string" },
          lng: { type: "string" },
          name: { type: "string" },
          place_id: { type: "string" },
          minutes: { type: "string" },
        },
      },
    },
    handler: async (req, reply) => {
      const q = req.query;
      const lat = Number(q.lat);
      const lng = Number(q.lng);
      const name = q.name?.trim();
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || !name) {
        return reply.status(400).send({ error: "Required: lat, lng, name" });
      }
      const minutes = Math.min(Number(q.minutes ?? 60), 120);
      if (!Number.isFinite(minutes) || minutes <= 0) {
        return reply.status(400).send({ error: "Invalid minutes param" });
      }
      // No cache — real-time
      reply.header("Cache-Control", "no-store");
      return getMergedDepartures(lat, lng, name, minutes, q.place_id);
    },
  });

  // GET /api/transit/arrivals/for-place?lat=&lng=&name=&minutes=60&place_id=
  server.get<{ Querystring: PlaceMinutesQuery }>("/transit/arrivals/for-place", {
    schema: {
      querystring: {
        type: "object",
        required: ["lat", "lng", "name"],
        properties: {
          lat: { type: "string" },
          lng: { type: "string" },
          name: { type: "string" },
          place_id: { type: "string" },
          minutes: { type: "string" },
        },
      },
    },
    handler: async (req, reply) => {
      const q = req.query;
      const lat = Number(q.lat);
      const lng = Number(q.lng);
      const name = q.name?.trim();
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || !name) {
        return reply.status(400).send({ error: "Required: lat, lng, name" });
      }
      const minutes = Math.min(Number(q.minutes ?? 60), 120);
      if (!Number.isFinite(minutes) || minutes <= 0) {
        return reply.status(400).send({ error: "Invalid minutes param" });
      }
      reply.header("Cache-Control", "no-store");
      return getMergedArrivals(lat, lng, name, minutes, q.place_id);
    },
  });

  // GET /api/transit/alerts/for-place?lat=&lng=&name=&place_id=
  server.get<{ Querystring: PlaceQuery }>("/transit/alerts/for-place", {
    schema: {
      querystring: {
        type: "object",
        required: ["lat", "lng", "name"],
        properties: {
          lat: { type: "string" },
          lng: { type: "string" },
          name: { type: "string" },
          place_id: { type: "string" },
        },
      },
    },
    handler: async (req, reply) => {
      const q = req.query;
      const lat = Number(q.lat);
      const lng = Number(q.lng);
      const name = q.name?.trim();
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || !name) {
        return reply.status(400).send({ error: "Required: lat, lng, name" });
      }
      reply.header("Cache-Control", "public, max-age=60, s-maxage=60");
      return getMergedAlerts(lat, lng, name, q.place_id);
    },
  });

  // GET /api/transit/facilities/for-place?lat=&lng=&name=&place_id=
  server.get<{ Querystring: PlaceQuery }>("/transit/facilities/for-place", {
    schema: {
      querystring: {
        type: "object",
        required: ["lat", "lng", "name"],
        properties: {
          lat: { type: "string" },
          lng: { type: "string" },
          name: { type: "string" },
          place_id: { type: "string" },
        },
      },
    },
    handler: async (req, reply) => {
      const q = req.query;
      const lat = Number(q.lat);
      const lng = Number(q.lng);
      const name = q.name?.trim();
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || !name) {
        return reply.status(400).send({ error: "Required: lat, lng, name" });
      }
      reply.header("Cache-Control", "public, max-age=86400, s-maxage=86400");
      return getMergedFacilities(lat, lng, name, q.place_id);
    },
  });

  // GET /api/transit/stops/:id
  server.get<{ Params: { id: string } }>("/transit/stops/:id", {
    schema: {
      params: idParamSchema,
    },
    handler: async (req, reply) => {
      const stop = await transitOrchestrator.getStop(decodeURIComponent(req.params.id));
      if (!stop) return reply.status(404).send({ error: "Stop not found" });
      return stop;
    },
  });

  // GET /api/transit/stops/:id/platform-stops
  server.get<{ Params: { id: string } }>("/transit/stops/:id/platform-stops", {
    schema: {
      params: idParamSchema,
    },
    handler: async (req, reply) => {
      reply.header("Cache-Control", "public, max-age=3600, s-maxage=3600");
      return transitOrchestrator.getStopPlatforms(decodeURIComponent(req.params.id));
    },
  });

  // GET /api/transit/stops/:id/timetable?date=YYYY-MM-DD
  server.get<{ Params: { id: string }; Querystring: TimetableQuery }>(
    "/transit/stops/:id/timetable",
    {
      schema: {
        params: idParamSchema,
        querystring: {
          type: "object",
          properties: {
            date: { type: "string" },
          },
        },
      },
      handler: async (req, reply) => {
        const date = req.query.date ?? utcDate();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
          return reply.status(400).send({ error: "Invalid date format. Use YYYY-MM-DD." });
        }
        const isPast = date < utcDate();
        reply.header(
          "Cache-Control",
          isPast ? "public, max-age=86400, s-maxage=86400" : "public, max-age=300, s-maxage=300",
        );
        return transitOrchestrator.getStopTimetable(decodeURIComponent(req.params.id), date);
      },
    },
  );

  // GET /api/transit/stops/:id/departures
  server.get<{ Params: { id: string }; Querystring: MinutesQuery }>(
    "/transit/stops/:id/departures",
    {
      schema: {
        params: idParamSchema,
        querystring: {
          type: "object",
          properties: {
            minutes: { type: "string" },
          },
        },
      },
      handler: async (req, reply) => {
        const minutes = Math.min(Number(req.query.minutes ?? 60), 120);
        if (!Number.isFinite(minutes) || minutes <= 0) {
          return reply.status(400).send({ error: "Invalid minutes param" });
        }
        reply.header("Cache-Control", "public, max-age=30, s-maxage=30");
        const departures = await transitOrchestrator.getDepartures(
          decodeURIComponent(req.params.id),
          minutes,
        );
        return departures;
      },
    },
  );

  // GET /api/transit/routes
  server.get<{ Querystring: RoutesQuery }>("/transit/routes", {
    schema: {
      querystring: {
        type: "object",
        properties: {
          stop_id: { type: "string" },
          ...bboxProperties,
        },
      },
    },
    handler: async (req, reply) => {
      const q = req.query;
      if (q.stop_id) {
        const routes = await transitOrchestrator.getRoutesForStop(q.stop_id);
        return routes;
      }
      const bbox = parseBBox(q as BBoxQuery);
      if (!bbox) {
        return reply.status(400).send({ error: "Provide stop_id or valid bbox params" });
      }
      const routes = await transitOrchestrator.getRoutesInBbox(bbox);
      return routes;
    },
  });

  // GET /api/transit/routes/:id
  server.get<{ Params: { id: string } }>("/transit/routes/:id", {
    schema: {
      params: idParamSchema,
    },
    handler: async (req, reply) => {
      const route = await transitOrchestrator.getRoute(decodeURIComponent(req.params.id));
      if (!route) return reply.status(404).send({ error: "Route not found" });
      return route;
    },
  });

  // GET /api/transit/alerts
  server.get<{ Querystring: BBoxQuery }>("/transit/alerts", {
    schema: {
      querystring: {
        type: "object",
        required: [...bboxRequired],
        properties: {
          ...bboxProperties,
        },
      },
    },
    handler: async (req, reply) => {
      const bbox = parseBBox(req.query);
      if (!bbox) return reply.status(400).send({ error: "Invalid or missing bbox params" });
      reply.header("Cache-Control", "public, max-age=60, s-maxage=60");
      const alerts = await transitOrchestrator.getAlerts(bbox);
      return alerts;
    },
  });

  // GET /api/transit/stops/:id/alerts
  server.get<{ Params: { id: string } }>("/transit/stops/:id/alerts", {
    schema: {
      params: idParamSchema,
    },
    handler: async (req, reply) => {
      reply.header("Cache-Control", "public, max-age=60, s-maxage=60");
      const alerts = await transitOrchestrator.getStopAlerts(decodeURIComponent(req.params.id));
      return alerts;
    },
  });

  // GET /api/transit/routes/:id/alerts
  server.get<{ Params: { id: string } }>("/transit/routes/:id/alerts", {
    schema: {
      params: idParamSchema,
    },
    handler: async (req, reply) => {
      reply.header("Cache-Control", "public, max-age=60, s-maxage=60");
      const alerts = await transitOrchestrator.getRouteAlerts(decodeURIComponent(req.params.id));
      return alerts;
    },
  });

  // GET /api/transit/routes/:id/live — vehicles + alerts combined
  server.get<{ Params: { id: string } }>("/transit/routes/:id/live", {
    schema: {
      params: idParamSchema,
    },
    handler: async (req, reply) => {
      reply.header("Cache-Control", "public, max-age=15, s-maxage=15");
      const routeId = decodeURIComponent(req.params.id);
      const [vehicles, alerts] = await Promise.all([
        transitOrchestrator.getVehiclePositions(routeId),
        transitOrchestrator.getRouteAlerts(routeId),
      ]);
      return { vehicles, alerts };
    },
  });

  // GET /api/transit/vehicles?route_id= OR ?sw_lat=&sw_lng=&ne_lat=&ne_lng= (radar)
  server.get<{ Querystring: VehiclesQuery }>("/transit/vehicles", {
    schema: {
      querystring: {
        type: "object",
        properties: {
          route_id: { type: "string" },
          ...bboxProperties,
        },
      },
    },
    handler: async (req, reply) => {
      const q = req.query;
      reply.header("Cache-Control", "public, max-age=15, s-maxage=15");

      if (q.route_id) {
        const vehicles = await transitOrchestrator.getVehiclePositions(q.route_id);
        return vehicles;
      }

      const bbox = parseBBox(q as BBoxQuery);
      if (bbox) {
        const vehicles = await transitOrchestrator.getVehicleRadar(bbox);
        return vehicles;
      }

      return reply
        .status(400)
        .send({ error: "Provide route_id or valid bbox params (sw_lat, sw_lng, ne_lat, ne_lng)" });
    },
  });

  // GET /api/transit/vehicles/:id?fallback_ids=id1,id2
  server.get<{ Params: { id: string }; Querystring: VehicleByIdQuery }>("/transit/vehicles/:id", {
    schema: {
      params: idParamSchema,
      querystring: {
        type: "object",
        properties: {
          fallback_ids: { type: "string" },
        },
      },
    },
    handler: async (req, reply) => {
      const fallbackIds = req.query.fallback_ids
        ? req.query.fallback_ids.split(",").map((s) => decodeURIComponent(s.trim()))
        : undefined;
      const journey = await transitOrchestrator.getVehicleJourney(
        decodeURIComponent(req.params.id),
        fallbackIds,
      );
      if (!journey) return reply.status(404).send({ error: "Vehicle journey not found" });
      return journey;
    },
  });

  // GET /api/transit/stops/:id/arrivals
  server.get<{ Params: { id: string }; Querystring: MinutesQuery }>("/transit/stops/:id/arrivals", {
    schema: {
      params: idParamSchema,
      querystring: {
        type: "object",
        properties: {
          minutes: { type: "string" },
        },
      },
    },
    handler: async (req, reply) => {
      const minutes = Math.min(Number(req.query.minutes ?? 60), 120);
      if (!Number.isFinite(minutes) || minutes <= 0) {
        return reply.status(400).send({ error: "Invalid minutes param" });
      }
      reply.header("Cache-Control", "public, max-age=60, s-maxage=60");
      const arrivals = await transitOrchestrator.getArrivals(
        decodeURIComponent(req.params.id),
        minutes,
      );
      return arrivals;
    },
  });

  // GET /api/transit/routes/:id/stops?hint_stop_id=
  server.get<{ Params: { id: string }; Querystring: RouteStopsQuery }>(
    "/transit/routes/:id/stops",
    {
      schema: {
        params: idParamSchema,
        querystring: {
          type: "object",
          properties: {
            hint_stop_id: { type: "string" },
          },
        },
      },
      handler: async (req, _reply) => {
        const hintStopId = req.query.hint_stop_id
          ? decodeURIComponent(req.query.hint_stop_id)
          : undefined;
        const stops = await transitOrchestrator.getRouteStops(
          decodeURIComponent(req.params.id),
          hintStopId,
        );
        return stops;
      },
    },
  );

  // GET /api/transit/stops/:id/facilities
  server.get<{ Params: { id: string } }>("/transit/stops/:id/facilities", {
    schema: {
      params: idParamSchema,
    },
    handler: async (req, _reply) => {
      const facilities = await transitOrchestrator.getFacilities(decodeURIComponent(req.params.id));
      return facilities;
    },
  });

  // GET /api/transit/providers — merged attribution map (static + dynamic registry)
  server.get("/transit/providers", async (_request, reply) => {
    reply.header("Cache-Control", "public, max-age=3600, s-maxage=3600");
    const result: Record<
      string,
      { label: string; url: string; license?: string; licenseUrl?: string }
    > = {
      ...STATIC_PROVIDER_ATTRIBUTION,
      ...getFeedProviders(),
    };
    for (const { slug, label, url } of registry.listProviders()) {
      if (!result[slug]) result[slug] = { label, url };
    }
    return result;
  });

  // GET /api/transit/health — provider health status (debug)
  server.get("/transit/health", async (_request, _reply) => {
    return { providers: transitOrchestrator.getHealthStatus() };
  });

  // GET /api/transit/plan
  server.get<{ Querystring: PlanQuery }>("/transit/plan", {
    schema: {
      querystring: {
        type: "object",
        required: ["from_lat", "from_lng", "to_lat", "to_lng"],
        properties: {
          from_lat: { type: "string" },
          from_lng: { type: "string" },
          to_lat: { type: "string" },
          to_lng: { type: "string" },
          time: { type: "string" },
          date: { type: "string" },
          modes: { type: "string" },
          num_itineraries: { type: "string" },
          arrive_by: { type: "string" },
          lang: { type: "string" },
        },
      },
    },
    handler: async (req, reply) => {
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
        return reply.status(400).send({
          error: "Invalid or missing coordinate params (from_lat, from_lng, to_lat, to_lng)",
        });
      }
      reply.header("Cache-Control", "private, max-age=60");
      // Accept `time` as full ISO 8601 (from frontend) or fall back to UTC now.
      // The frontend sends the user's local time converted to UTC.
      let date: string;
      let time: string;
      if (q.time?.includes("T")) {
        // Full ISO timestamp, e.g. "2026-03-09T20:00:00Z"
        const d = new Date(q.time);
        date = d.toISOString().slice(0, 10);
        time = d.toISOString().slice(11, 19);
      } else {
        date = q.date ?? utcDate();
        // Normalize to HH:MM:SS — avoid double-appending :00 if seconds already present
        time = q.time ? (q.time.split(":").length >= 3 ? q.time : `${q.time}:00`) : utcTime();
      }
      const _numItineraries = Math.min(Math.max(Number(q.num_itineraries ?? 3), 1), 10);
      const plan = await transitOrchestrator.planTrip({
        from: { lat: fromLat, lng: fromLng },
        to: { lat: toLat, lng: toLng },
        departureTime: `${date}T${time}`,
        modes: (q.modes ?? "TRANSIT").split(",").map((m) => m.trim()),
      });
      if (!plan) {
        return reply.status(503).send({
          error: "Trip planning unavailable — no transit provider could serve this route",
        });
      }
      return plan;
    },
  });

  // GET /api/transit/reachable?lat=&lng=&maxTravelTime=30&modes=
  server.get(
    "/transit/reachable",
    {
      schema: {
        querystring: {
          type: "object",
          required: ["lat", "lng"],
          properties: {
            lat: { type: "number" },
            lng: { type: "number" },
            maxTravelTime: { type: "integer", default: 30 },
            modes: { type: "string" },
          },
        },
      },
    },
    async (req, reply) => {
      const q = req.query as { lat: number; lng: number; maxTravelTime: number; modes?: string };
      const lat = q.lat;
      const lng = q.lng;
      const maxTravelTime = Math.min(q.maxTravelTime, 120);
      const modes = q.modes;

      const cacheKey = hashKey("cache:transit:reachable", {
        lat: lat.toFixed(3),
        lng: lng.toFixed(3),
        maxTravelTime: String(maxTravelTime),
        modes: modes ?? "",
      });

      const results = await withCache(cacheKey, 300, () =>
        transitOrchestrator.getReachableStops(
          lat,
          lng,
          maxTravelTime,
          modes?.split(",").map((m) => m.trim()),
        ),
      );

      reply.header("Cache-Control", "public, max-age=300");
      return results;
    },
  );
}
