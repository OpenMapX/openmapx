import type { FastifyPluginAsync } from "fastify";
import { getGeocodingProvider } from "../services/geocoding.factory";
import { hashKey, round, TTL, withCache } from "../utils/cache.js";

export const geocodeRoute: FastifyPluginAsync = async (fastify) => {
  fastify.get<{ Querystring: { q: string; lang?: string } }>("/geocode", {
    schema: {
      querystring: {
        type: "object",
        required: ["q"],
        properties: {
          q: { type: "string", minLength: 1 },
          lang: { type: "string" },
        },
      },
    },
    handler: async (req, reply) => {
      const { q, lang } = req.query;
      const effectiveLang = lang ?? "en";
      const result = await withCache(
        hashKey("cache:geocode", { q, lang: effectiveLang }),
        TTL.geocoding.forward,
        () => getGeocodingProvider().geocode(q, effectiveLang),
      );
      reply.header("Cache-Control", "public, max-age=86400");
      return result;
    },
  });

  fastify.get<{ Querystring: { lat: string; lng: string; lang?: string } }>("/geocode/reverse", {
    schema: {
      querystring: {
        type: "object",
        required: ["lat", "lng"],
        properties: {
          lat: { type: "string" },
          lng: { type: "string" },
          lang: { type: "string" },
        },
      },
    },
    handler: async (req, reply) => {
      const lat = Number.parseFloat(req.query.lat);
      const lng = Number.parseFloat(req.query.lng);
      const lang = req.query.lang;
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        return reply.status(400).send({ error: "lat and lng must be valid numbers" });
      }
      // Round to 4dp (~11m) to maximise cache hits for nearby queries
      const effectiveLang = lang ?? "en";
      const key = `cache:geocode:rev:${round(lat, 4)}:${round(lng, 4)}:${effectiveLang}`;
      const result = await withCache(key, TTL.geocoding.reverse, () =>
        getGeocodingProvider().reverseGeocode(lat, lng, effectiveLang),
      );
      reply.header("Cache-Control", "public, max-age=86400");
      return result;
    },
  });
};
