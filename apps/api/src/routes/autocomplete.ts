import type { FastifyPluginAsync } from "fastify";
import { getGeocodingProvider } from "../services/geocoding.factory";
import { hashKey, withCache } from "../utils/cache.js";

export const autocompleteRoute: FastifyPluginAsync = async (fastify) => {
  fastify.get<{ Querystring: { q: string } }>("/autocomplete", {
    schema: {
      querystring: {
        type: "object",
        required: ["q"],
        properties: { q: { type: "string", minLength: 1 } },
      },
    },
    handler: async (req, reply) => {
      const result = await withCache(hashKey("cache:autocomplete", req.query.q), 3600, () =>
        getGeocodingProvider().autocomplete(req.query.q),
      );
      reply.header("Cache-Control", "public, max-age=3600");
      return result;
    },
  });
};
