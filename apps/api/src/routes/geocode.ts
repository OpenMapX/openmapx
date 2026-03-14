import type { FastifyPluginAsync } from "fastify";
import { getGeocodingProvider } from "../services/geocoding.factory";
import { hashKey, round, withCache } from "../utils/cache.js";

export const geocodeRoute: FastifyPluginAsync = async (fastify) => {
  fastify.get<{ Querystring: { q: string } }>("/geocode", {
    schema: {
      querystring: {
        type: "object",
        required: ["q"],
        properties: { q: { type: "string", minLength: 1 } },
      },
    },
    handler: async (req, reply) => {
      const result = await withCache(hashKey("cache:geocode", req.query.q), 86400, () =>
        getGeocodingProvider().geocode(req.query.q),
      );
      reply.header("Cache-Control", "public, max-age=86400");
      return result;
    },
  });

  fastify.get<{ Querystring: { lat: string; lng: string } }>("/geocode/reverse", {
    schema: {
      querystring: {
        type: "object",
        required: ["lat", "lng"],
        properties: {
          lat: { type: "string" },
          lng: { type: "string" },
        },
      },
    },
    handler: async (req, reply) => {
      const lat = Number.parseFloat(req.query.lat);
      const lng = Number.parseFloat(req.query.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        return reply.status(400).send({ error: "lat and lng must be valid numbers" });
      }
      // Round to 4dp (~11m) to maximise cache hits for nearby queries
      const key = `cache:geocode:rev:${round(lat, 4)}:${round(lng, 4)}`;
      const result = await withCache(key, 86400, () =>
        getGeocodingProvider().reverseGeocode(lat, lng),
      );
      reply.header("Cache-Control", "public, max-age=86400");
      return result;
    },
  });
};
