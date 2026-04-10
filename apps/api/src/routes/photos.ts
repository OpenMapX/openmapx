import type { FastifyPluginAsync } from "fastify";
import { lookupByNameAndCoords, lookupByOsmRef } from "../services/nominatim-lookup.service";
import { searchPhotos } from "../services/photos/index";
import { TTL, withCache } from "../utils/cache.js";

const OSM_ID_RE = /^(node|way|relation)\/(\d+)$/;

export const photosRoute: FastifyPluginAsync = async (fastify) => {
  fastify.get<{
    Querystring: {
      lat: string;
      lng: string;
      name?: string;
      placeId?: string;
      limit?: string;
    };
  }>("/photos", {
    schema: {
      querystring: {
        type: "object",
        required: ["lat", "lng"],
        properties: {
          lat: { type: "string" },
          lng: { type: "string" },
          name: { type: "string" },
          placeId: { type: "string" },
          limit: { type: "string" },
        },
      },
    },
    handler: async (req, reply) => {
      const lat = Number.parseFloat(req.query.lat);
      const lng = Number.parseFloat(req.query.lng);

      if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        return reply.status(400).send({ error: "Invalid coordinates" });
      }
      if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
        return reply.status(400).send({ error: "Coordinates out of range" });
      }

      const limit = Math.min(Number.parseInt(req.query.limit ?? "20", 10) || 20, 50);
      const name = req.query.name?.trim();
      const placeId = req.query.placeId?.trim();

      const nameKey = name ? `:${name.slice(0, 40)}` : "";
      const placeKey = placeId ? `:${placeId.slice(0, 40)}` : "";
      const cacheKey = `cache:photos:${lat.toFixed(4)}:${lng.toFixed(4)}:${limit}${nameKey}${placeKey}`;

      try {
        const photos = await withCache(cacheKey, TTL.photos, async () => {
          // If placeId is provided, resolve OSM tags for tag-based photo lookups
          let osmTags: Record<string, string> | undefined;
          if (placeId) {
            osmTags = await resolveOsmTags(placeId, name, lat, lng);
          }
          return searchPhotos({ lat, lng, name, limit, osmTags });
        });

        reply.header("Cache-Control", "public, max-age=3600");
        return { photos };
      } catch (err) {
        req.log.error(err, "Photo search failed");
        return reply.status(500).send({ error: "Photo search failed" });
      }
    },
  });
};

/** Resolve OSM tags for a place by ID or coordinates+name. Returns undefined on failure. */
async function resolveOsmTags(
  placeId: string,
  name: string | undefined,
  lat: number,
  lng: number,
): Promise<Record<string, string> | undefined> {
  try {
    const match = placeId.match(OSM_ID_RE);
    if (match) {
      const [, osmType, osmId] = match;
      const place = await lookupByOsmRef(osmType, osmId, placeId);
      return place.osmTags ?? undefined;
    }
    if (name) {
      const place = await lookupByNameAndCoords(name, lat, lng, placeId);
      return place?.osmTags ?? undefined;
    }
  } catch {
    // Tag resolution failed — coordinate-based providers will still work
  }
  return undefined;
}
