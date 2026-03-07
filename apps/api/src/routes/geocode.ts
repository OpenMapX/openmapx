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
    handler: async (req) => {
      const lat = Number.parseFloat(req.query.lat);
      const lng = Number.parseFloat(req.query.lng);
      return getGeocodingProvider().reverseGeocode(lat, lng);
    },
  });
};
