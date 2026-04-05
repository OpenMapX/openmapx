import type { FastifyInstance } from "fastify";
import {
  getMergedAlerts,
  getMergedArrivals,
  getMergedDepartures,
  getMergedFacilities,
  getMergedRoutes,
} from "../../services/transit/place-transit";
import {
  type PlaceMinutesQuery,
  type PlaceQuery,
  parseMinutes,
  parsePlaceQuery,
  placeMinutesSchema,
  placeSchema,
} from "./shared";

export async function placeRoutes(server: FastifyInstance): Promise<void> {
  // GET /api/transit/routes/for-place?lat=&lng=&name=&place_id=
  server.get<{ Querystring: PlaceQuery }>("/transit/routes/for-place", {
    schema: { querystring: placeSchema },
    handler: async (req, reply) => {
      const place = parsePlaceQuery(req.query);
      if (!place) return reply.status(400).send({ error: "Required: lat, lng, name" });
      reply.header("Cache-Control", "public, max-age=300, s-maxage=300");
      return getMergedRoutes(place.lat, place.lng, place.name, req.query.place_id);
    },
  });

  // GET /api/transit/departures/for-place?lat=&lng=&name=&minutes=60&place_id=
  server.get<{ Querystring: PlaceMinutesQuery }>("/transit/departures/for-place", {
    schema: { querystring: placeMinutesSchema },
    handler: async (req, reply) => {
      const place = parsePlaceQuery(req.query);
      if (!place) return reply.status(400).send({ error: "Required: lat, lng, name" });
      const minutes = parseMinutes(req.query.minutes);
      if (!minutes) return reply.status(400).send({ error: "Invalid minutes param" });
      reply.header("Cache-Control", "no-store");
      return getMergedDepartures(place.lat, place.lng, place.name, minutes, req.query.place_id);
    },
  });

  // GET /api/transit/arrivals/for-place?lat=&lng=&name=&minutes=60&place_id=
  server.get<{ Querystring: PlaceMinutesQuery }>("/transit/arrivals/for-place", {
    schema: { querystring: placeMinutesSchema },
    handler: async (req, reply) => {
      const place = parsePlaceQuery(req.query);
      if (!place) return reply.status(400).send({ error: "Required: lat, lng, name" });
      const minutes = parseMinutes(req.query.minutes);
      if (!minutes) return reply.status(400).send({ error: "Invalid minutes param" });
      reply.header("Cache-Control", "no-store");
      return getMergedArrivals(place.lat, place.lng, place.name, minutes, req.query.place_id);
    },
  });

  // GET /api/transit/alerts/for-place?lat=&lng=&name=&place_id=
  server.get<{ Querystring: PlaceQuery }>("/transit/alerts/for-place", {
    schema: { querystring: placeSchema },
    handler: async (req, reply) => {
      const place = parsePlaceQuery(req.query);
      if (!place) return reply.status(400).send({ error: "Required: lat, lng, name" });
      reply.header("Cache-Control", "public, max-age=60, s-maxage=60");
      return getMergedAlerts(place.lat, place.lng, place.name, req.query.place_id);
    },
  });

  // GET /api/transit/facilities/for-place?lat=&lng=&name=&place_id=
  server.get<{ Querystring: PlaceQuery }>("/transit/facilities/for-place", {
    schema: { querystring: placeSchema },
    handler: async (req, reply) => {
      const place = parsePlaceQuery(req.query);
      if (!place) return reply.status(400).send({ error: "Required: lat, lng, name" });
      reply.header("Cache-Control", "public, max-age=86400, s-maxage=86400");
      return getMergedFacilities(place.lat, place.lng, place.name, req.query.place_id);
    },
  });
}
