import type { FastifyPluginAsync } from "fastify";
import { getGeocodingProvider } from "../services/geocoding.factory";

export const autocompleteRoute: FastifyPluginAsync = async (fastify) => {
  fastify.get<{ Querystring: { q: string } }>("/autocomplete", {
    schema: {
      querystring: {
        type: "object",
        required: ["q"],
        properties: { q: { type: "string", minLength: 1 } },
      },
    },
    handler: async (req) => {
      return getGeocodingProvider().autocomplete(req.query.q);
    },
  });
};
