import type { FastifyPluginAsync } from "fastify";
import { getGeocodingProvider } from "../services/geocoding.factory";
import { hashKey, TTL, withCache } from "../utils/cache.js";

export const autocompleteRoute: FastifyPluginAsync = async (fastify) => {
  fastify.get<{ Querystring: { q: string; lang?: string } }>("/autocomplete", {
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
        hashKey("cache:autocomplete", { q, lang: effectiveLang }),
        TTL.geocoding.autocomplete,
        () => getGeocodingProvider().autocomplete(q, effectiveLang),
      );
      reply.header("Cache-Control", "public, max-age=3600");
      return result;
    },
  });
};
