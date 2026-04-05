import type { FastifyInstance } from "fastify";
import { transitOrchestrator } from "../../services/transit/orchestrator";
import { getLinkedStops } from "../../services/transit/place-transit";
import type { BBox } from "../../services/transit/types";
import {
  type BBoxQuery,
  bboxProperties,
  bboxRequired,
  idParamSchema,
  type MinutesQuery,
  type PlaceQuery,
  parseBBox,
  parseMinutes,
  parseModes,
  parsePlaceQuery,
  placeSchema,
  utcDate,
} from "./shared";

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

interface TimetableQuery {
  date?: string;
}

export async function stopsRoutes(server: FastifyInstance): Promise<void> {
  // GET /api/transit/stops
  server.get<{ Querystring: StopsQuery }>("/transit/stops", {
    schema: {
      querystring: {
        type: "object",
        required: [...bboxRequired],
        properties: { ...bboxProperties, modes: { type: "string" } },
      },
    },
    handler: async (req, reply) => {
      const bbox = parseBBox(req.query);
      if (!bbox) {
        return reply
          .status(400)
          .send({ error: "Invalid or missing bbox params (sw_lat, sw_lng, ne_lat, ne_lng)" });
      }
      return transitOrchestrator.getStopsInBbox(bbox, parseModes(req.query.modes));
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
      const lat = Number(req.query.lat);
      const lng = Number(req.query.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        return reply.status(400).send({ error: "Required: lat, lng" });
      }
      const radiusMeters = Math.min(Number(req.query.radius ?? 500), 2000);
      const latDelta = radiusMeters / 111_320;
      const lngDelta = radiusMeters / (111_320 * Math.cos((lat * Math.PI) / 180));
      const bbox: BBox = [lng - lngDelta, lat - latDelta, lng + lngDelta, lat + latDelta];
      reply.header("Cache-Control", "public, max-age=300, s-maxage=300");
      return transitOrchestrator.getStopsInBbox(bbox, parseModes(req.query.modes));
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
    schema: { querystring: placeSchema },
    handler: async (req, reply) => {
      const place = parsePlaceQuery(req.query);
      if (!place) return reply.status(400).send({ error: "Required: lat, lng, name" });
      reply.header("Cache-Control", "public, max-age=86400, s-maxage=86400");
      return getLinkedStops(place.lat, place.lng, place.name, req.query.place_id);
    },
  });

  // GET /api/transit/stops/:id
  server.get<{ Params: { id: string } }>("/transit/stops/:id", {
    schema: { params: idParamSchema },
    handler: async (req, reply) => {
      const stop = await transitOrchestrator.getStop(decodeURIComponent(req.params.id));
      if (!stop) return reply.status(404).send({ error: "Stop not found" });
      return stop;
    },
  });

  // GET /api/transit/stops/:id/platform-stops
  server.get<{ Params: { id: string } }>("/transit/stops/:id/platform-stops", {
    schema: { params: idParamSchema },
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
        querystring: { type: "object", properties: { date: { type: "string" } } },
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
        querystring: { type: "object", properties: { minutes: { type: "string" } } },
      },
      handler: async (req, reply) => {
        const minutes = parseMinutes(req.query.minutes);
        if (!minutes) return reply.status(400).send({ error: "Invalid minutes param" });
        reply.header("Cache-Control", "public, max-age=30, s-maxage=30");
        return transitOrchestrator.getDepartures(decodeURIComponent(req.params.id), minutes);
      },
    },
  );

  // GET /api/transit/stops/:id/arrivals
  server.get<{ Params: { id: string }; Querystring: MinutesQuery }>("/transit/stops/:id/arrivals", {
    schema: {
      params: idParamSchema,
      querystring: { type: "object", properties: { minutes: { type: "string" } } },
    },
    handler: async (req, reply) => {
      const minutes = parseMinutes(req.query.minutes);
      if (!minutes) return reply.status(400).send({ error: "Invalid minutes param" });
      reply.header("Cache-Control", "public, max-age=60, s-maxage=60");
      return transitOrchestrator.getArrivals(decodeURIComponent(req.params.id), minutes);
    },
  });

  // GET /api/transit/stops/:id/alerts
  server.get<{ Params: { id: string } }>("/transit/stops/:id/alerts", {
    schema: { params: idParamSchema },
    handler: async (req, reply) => {
      reply.header("Cache-Control", "public, max-age=60, s-maxage=60");
      const alerts = await transitOrchestrator.getStopAlerts(decodeURIComponent(req.params.id));
      return alerts;
    },
  });

  // GET /api/transit/stops/:id/facilities
  server.get<{ Params: { id: string } }>("/transit/stops/:id/facilities", {
    schema: { params: idParamSchema },
    handler: async (req, _reply) => {
      const facilities = await transitOrchestrator.getFacilities(decodeURIComponent(req.params.id));
      return facilities;
    },
  });
}
