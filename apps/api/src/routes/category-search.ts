import type { FastifyPluginAsync } from "fastify";
import { CATEGORY_FILTERS, searchByCategory } from "../services/overpass.service";

interface CategorySearchQuery {
  category: string;
  south: string;
  west: string;
  north: string;
  east: string;
}

export const categorySearchRoute: FastifyPluginAsync = async (fastify) => {
  fastify.get<{ Querystring: CategorySearchQuery }>("/places/search", {
    schema: {
      querystring: {
        type: "object",
        required: ["category", "south", "west", "north", "east"],
        properties: {
          category: { type: "string" },
          south: { type: "string" },
          west: { type: "string" },
          north: { type: "string" },
          east: { type: "string" },
        },
      },
    },
    handler: async (req, reply) => {
      const { category, south, west, north, east } = req.query;

      const filters = CATEGORY_FILTERS[category];
      if (!filters) {
        return reply.status(400).send({ error: `Unknown category: ${category}` });
      }

      const bbox = {
        south: Number.parseFloat(south),
        west: Number.parseFloat(west),
        north: Number.parseFloat(north),
        east: Number.parseFloat(east),
      };

      for (const [key, val] of Object.entries(bbox)) {
        if (!Number.isFinite(val)) {
          return reply.status(400).send({ error: `Invalid bbox parameter: ${key}` });
        }
      }

      const results = await searchByCategory(filters, bbox);
      return results;
    },
  });
};
