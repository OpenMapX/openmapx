import type { FastifyPluginAsync } from "fastify";
import { searchFuelStations } from "../services/fuel-prices/factory";
import type { CategoryPlaceResult } from "../services/overpass.service";
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

      // For the fuel category, delegate to live price providers where available.
      // Falls back to Overpass when no provider covers this area (outside Germany)
      // or when the API key is not configured.
      if (category === "fuel") {
        try {
          const fuelStations = await searchFuelStations(bbox);
          if (fuelStations !== null) {
            const results: CategoryPlaceResult[] = fuelStations.map((s) => ({
              id: s.id,
              name: s.name,
              coordinates: s.coordinates,
              address: s.address,
              category: "fuel",
              isOpen: s.isOpen,
              fuelPrices: s.fuelPrices,
              fuelPricesUpdatedAt: s.fuelPricesUpdatedAt,
              fuelAttribution: s.attribution,
            }));
            return results;
          }
        } catch (err) {
          // Provider failed — log and fall through to Overpass
          fastify.log.warn(err, "Fuel price provider error, falling back to Overpass");
        }
      }

      const filters = CATEGORY_FILTERS[category];
      if (!filters) {
        return reply.status(400).send({ error: `Unknown category: ${category}` });
      }

      const results = await searchByCategory(filters, bbox);
      return results;
    },
  });
};
