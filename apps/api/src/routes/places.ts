import type { FastifyPluginAsync } from "fastify";
import { enrichPlace } from "../services/enrichment/index";
import { lookupByNameAndCoords, lookupByOsmRef } from "../services/nominatim-lookup.service";
import { buildReviewLinks } from "../services/review-links";
import { withCache } from "../utils/cache.js";

// Matches "node/12345", "way/678", "relation/99"
const OSM_ID_RE = /^(node|way|relation)\/(\d+)$/;

interface PlaceByIdQuery {
  lat?: string;
  lng?: string;
  name?: string;
}

interface CacheableError {
  statusCode: number;
  message: string;
}

export const placesRoute: FastifyPluginAsync = async (fastify) => {
  fastify.get("/places", async () => {
    return { data: [], message: "Not yet implemented" };
  });

  fastify.get<{
    Params: { id: string };
    Querystring: PlaceByIdQuery;
  }>("/places/:id", {
    schema: {
      params: {
        type: "object",
        required: ["id"],
        properties: { id: { type: "string" } },
      },
      querystring: {
        type: "object",
        properties: {
          lat: { type: "string" },
          lng: { type: "string" },
          name: { type: "string" },
        },
      },
    },
    handler: async (req, reply) => {
      const rawId = decodeURIComponent(req.params.id);
      const cacheKey = `cache:place:${rawId}`;

      // Cache-Control is set only on success — error responses (400/404) must not
      // be cached because browsers can cache them when Cache-Control: public is present.
      try {
        const result = await withCache(cacheKey, 86400, async () => {
          const match = rawId.match(OSM_ID_RE);

          if (match) {
            const [, osmType, osmId] = match;
            const place = await lookupByOsmRef(osmType, osmId, rawId);
            const { externalIds, ...enrichment } = await enrichPlace(place);
            return { ...place, ...enrichment, reviewLinks: buildReviewLinks(place, externalIds) };
          }

          const lat = Number.parseFloat(req.query.lat ?? "");
          const lng = Number.parseFloat(req.query.lng ?? "");
          const name = req.query.name?.trim() ?? "";

          if (!Number.isFinite(lat) || !Number.isFinite(lng) || !name) {
            const err: CacheableError = {
              statusCode: 400,
              message: "Non-OSM place ID requires lat, lng, and name query parameters",
            };
            throw err;
          }

          const place = await lookupByNameAndCoords(name, lat, lng, rawId);
          if (!place) {
            const err: CacheableError = {
              statusCode: 404,
              message: `No OSM match found for "${name}" near [${lat}, ${lng}]`,
            };
            throw err;
          }

          const { externalIds, ...enrichment } = await enrichPlace(place);
          return { ...place, ...enrichment, reviewLinks: buildReviewLinks(place, externalIds) };
        });
        reply.header("Cache-Control", "public, max-age=86400");
        return result;
      } catch (err) {
        const e = err as CacheableError;
        const statusCode = e.statusCode ?? 500;
        return reply
          .status(statusCode)
          .send({ error: statusCode >= 500 ? "Internal server error" : e.message });
      }
    },
  });
};
