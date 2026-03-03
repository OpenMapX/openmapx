import type { FastifyPluginAsync } from "fastify";
import { getGeocodingProvider } from "../services/geocoding.factory";

export const geocodeRoute: FastifyPluginAsync = async (fastify) => {
  fastify.get<{ Querystring: { q: string } }>("/geocode", {
    schema: {
      querystring: {
        type: "object",
        required: ["q"],
        properties: { q: { type: "string", minLength: 1 } },
      },
    },
    handler: async (req) => {
      return getGeocodingProvider().geocode(req.query.q);
    },
  });
};
