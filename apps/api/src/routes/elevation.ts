import type { FastifyPluginAsync } from "fastify";
import { elevationService } from "../services/elevation.service.js";
import { hashKey, TTL, withCache } from "../utils/cache.js";

export const elevationRoute: FastifyPluginAsync = async (fastify) => {
  fastify.post<{
    Body: {
      coordinates: [number, number][];
      routeDistance?: number;
    };
  }>("/elevation", {
    schema: {
      body: {
        type: "object",
        required: ["coordinates"],
        properties: {
          coordinates: {
            type: "array",
            items: {
              type: "array",
              items: { type: "number" },
              minItems: 2,
              maxItems: 2,
            },
            minItems: 2,
            maxItems: 5000,
          },
          routeDistance: { type: "number" },
        },
      },
    },
    handler: async (req, reply) => {
      const { coordinates, routeDistance } = req.body;

      // Build cache key from a hash of the coordinates (rounded to 4 decimals)
      const rounded = coordinates.map(
        ([lng, lat]) =>
          [Math.round(lng * 1e4) / 1e4, Math.round(lat * 1e4) / 1e4] as [number, number],
      );
      const key = hashKey("cache:elevation", { coords: rounded, dist: routeDistance });

      try {
        const result = await withCache(key, TTL.elevation, async () => {
          const data = await elevationService.getElevation(coordinates, routeDistance);
          if (!data) throw new Error("Elevation data unavailable");
          return data;
        });
        reply.header("Cache-Control", "public, max-age=86400");
        return result;
      } catch {
        return reply.status(502).send({ error: "Elevation data unavailable" });
      }
    },
  });
};
