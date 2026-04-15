import { lookupDbStation } from "@integrations/geocoding-db-ris/provider.js";
import type { Place } from "@openmapx/core";
import type { FastifyPluginAsync } from "fastify";
import {
  lookupAddressByCoords,
  lookupByCoords,
  lookupByNameAndCoords,
  lookupByOsmFilters,
  lookupByOsmRef,
} from "../../../../integrations/geocoding/place-lookup.js";
import {
  deduplicatePhotos,
  searchHeroPhotos,
} from "../../../../integrations/photos/orchestrator.js";
import { getPlaceKnowledge } from "../services/knowledge/index";
import { buildReviewLinks } from "../services/review-links";
import { TTL, withCache } from "../utils/cache.js";

// Matches "node/12345", "way/678", "relation/99"
const OSM_ID_RE = /^(node|way|relation)\/(\d+)$/;

interface PlaceByIdQuery {
  lat?: string;
  lng?: string;
  name?: string;
  lang?: string;
  osmFilters?: string;
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
          lang: { type: "string" },
          osmFilters: { type: "string" },
        },
      },
    },
    handler: async (req, reply) => {
      const rawId = decodeURIComponent(req.params.id);
      const lang = req.query.lang;
      const effectiveLang = lang ?? "en";
      const cacheKey = `cache:place:${rawId}:${effectiveLang}`;

      // Cache-Control is set only on success — error responses (400/404) must not
      // be cached because browsers can cache them when Cache-Control: public is present.
      try {
        const result = await withCache(cacheKey, TTL.places.detail, async () => {
          // DB station lookup (RIS::Stations)
          if (rawId.startsWith("db-")) {
            const evaNumber = rawId.slice(3);
            if (!/^\d+$/.test(evaNumber)) {
              const err: CacheableError = { statusCode: 400, message: "Invalid EVA number" };
              throw err;
            }
            return lookupDbStation(evaNumber, lang);
          }

          const match = rawId.match(OSM_ID_RE);

          if (match) {
            const [, osmType, osmId] = match;
            const place = await lookupByOsmRef(osmType, osmId, rawId, lang);
            const {
              externalIds,
              photos: knowledgePhotos,
              ...knowledge
            } = await getPlaceKnowledge(place, lang);
            const heroPhotos = place.osmTags ? await searchHeroPhotos(place.osmTags) : [];
            const photos = deduplicatePhotos([...heroPhotos, ...(knowledgePhotos ?? [])]);
            return {
              ...place,
              ...knowledge,
              photos,
              reviewLinks: buildReviewLinks(place, externalIds),
            };
          }

          const lat = Number.parseFloat(req.query.lat ?? "");
          const lng = Number.parseFloat(req.query.lng ?? "");
          const name = req.query.name?.trim() ?? "";

          if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
            const err: CacheableError = {
              statusCode: 400,
              message: "Non-OSM place ID requires lat and lng query parameters",
            };
            throw err;
          }

          const isDataSourceLookup = rawId.startsWith("ds-");

          let place: Place | null = null;
          if (isDataSourceLookup) {
            // Data source items: Overpass category search finds the correct OSM node
            // by type rather than returning the nearest element of any type.
            const osmFiltersRaw = req.query.osmFilters;
            if (!osmFiltersRaw) {
              const err: CacheableError = {
                statusCode: 400,
                message: "Data source place lookup requires osmFilters query parameter",
              };
              throw err;
            }
            let osmFilters: Array<{ key: string; value: string }>;
            try {
              const parsed: unknown = JSON.parse(osmFiltersRaw);
              if (
                !Array.isArray(parsed) ||
                !parsed.every(
                  (f) =>
                    typeof f === "object" &&
                    f !== null &&
                    typeof (f as Record<string, unknown>).key === "string" &&
                    typeof (f as Record<string, unknown>).value === "string",
                )
              ) {
                throw new Error("shape");
              }
              osmFilters = parsed as Array<{ key: string; value: string }>;
            } catch {
              const err: CacheableError = {
                statusCode: 400,
                message: "Invalid osmFilters: expected Array<{key,value}>",
              };
              throw err;
            }
            place = await lookupByOsmFilters(lat, lng, osmFilters, rawId);

            // OSM nodes for data source items (bike sharing, parking, etc.) rarely carry
            // addr:* tags. If the Overpass result has no address, fall back to a structured
            // reverse geocode at zoom=18 for address/city only — never for POI details.
            if (!place?.address) {
              const addrOnly = await lookupAddressByCoords(lat, lng);
              if (addrOnly) {
                place = place
                  ? { ...place, address: addrOnly.address, city: addrOnly.city ?? place.city }
                  : {
                      id: rawId,
                      name: "",
                      address: addrOnly.address,
                      city: addrOnly.city,
                      coordinates: [lng, lat],
                    };
              }
            }
          } else {
            if (!name) {
              const err: CacheableError = {
                statusCode: 400,
                message: "Non-OSM place ID requires lat, lng, and name query parameters",
              };
              throw err;
            }
            place =
              (await lookupByNameAndCoords(name, lat, lng, rawId, lang)) ??
              (await lookupByCoords(lat, lng, rawId, lang));
          }

          if (!place) {
            const err: CacheableError = {
              statusCode: 404,
              message: `No OSM match found near [${lat}, ${lng}]`,
            };
            throw err;
          }

          const {
            externalIds,
            photos: knowledgePhotos,
            ...knowledge
          } = await getPlaceKnowledge(place, lang);
          const heroPhotos = place.osmTags ? await searchHeroPhotos(place.osmTags) : [];
          const photos = deduplicatePhotos([...heroPhotos, ...(knowledgePhotos ?? [])]);
          return {
            ...place,
            ...knowledge,
            photos,
            reviewLinks: buildReviewLinks(place, externalIds),
          };
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
