import { type BoundingBox, OverpassTimeoutError, type PoiSearchProvider } from "@openmapx/core";
import type { FastifyPluginAsync } from "fastify";
import { getIntegrationsByDomain } from "../integration-host.js";
import { hashKey, round, TTL, withCache } from "../utils/cache.js";

const MAX_SHRINK_RETRIES = 3;
const SHRINK_FACTOR = 0.6;

function shrinkBbox(bbox: BoundingBox, factor: number): BoundingBox {
  const centerLat = (bbox.north + bbox.south) / 2;
  const centerLon = (bbox.east + bbox.west) / 2;
  const halfLat = ((bbox.north - bbox.south) / 2) * factor;
  const halfLon = ((bbox.east - bbox.west) / 2) * factor;
  return {
    south: centerLat - halfLat,
    north: centerLat + halfLat,
    west: centerLon - halfLon,
    east: centerLon + halfLon,
  };
}

function getPoiSearchProviders(): PoiSearchProvider[] {
  const integrations = getIntegrationsByDomain("poi-search");
  const providers: PoiSearchProvider[] = [];
  for (const integration of integrations) {
    const registered = (integration.providers.get("poi-search") ?? []) as PoiSearchProvider[];
    providers.push(...registered);
  }
  return providers;
}

interface CategorySearchQuery {
  category: string;
  south: string;
  west: string;
  north: string;
  east: string;
  lang?: string;
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
          lang: { type: "string" },
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

      const ttl = TTL.category;

      // Round bbox to 2dp (~1km) — queries within 1km share a cache entry
      const bboxRounded = {
        east: round(bbox.east, 2),
        north: round(bbox.north, 2),
        south: round(bbox.south, 2),
        west: round(bbox.west, 2),
      };
      const cacheKey = hashKey(`cache:category:${category}`, bboxRounded);

      // Cache-Control is set only on success — not on 400 error responses.
      try {
        const result = await withCache(cacheKey, ttl, async () => {
          const providers = getPoiSearchProviders();
          const provider = providers.find((p) => p.categories.includes(category));
          if (!provider) {
            throw Object.assign(new Error(`Unknown category: ${category}`), { statusCode: 400 });
          }

          // On Overpass timeout, retry with progressively smaller bbox
          let currentBbox = bbox;
          for (let attempt = 0; ; attempt++) {
            try {
              const results = await provider.search(category, currentBbox, {
                lang: req.query.lang,
              });
              return { results, partial: attempt > 0 };
            } catch (err) {
              if (err instanceof OverpassTimeoutError && attempt < MAX_SHRINK_RETRIES) {
                currentBbox = shrinkBbox(currentBbox, SHRINK_FACTOR);
                continue;
              }
              throw err;
            }
          }
        });
        reply.header("Cache-Control", `public, max-age=${ttl}`);
        return result;
      } catch (err) {
        if (err instanceof OverpassTimeoutError) {
          return reply.status(422).send({ error: "area_too_large" });
        }
        const e = err as { statusCode?: number; message: string };
        if (e.statusCode === 400) {
          return reply.status(400).send({ error: e.message });
        }
        throw err;
      }
    },
  });
};
