import type { Place } from "@openmapx/core";
import {
  getPlaceResolver,
  type PlaceIds,
  type PlaceResolverContext,
  parseId,
} from "@openmapx/core";
import type { FastifyPluginAsync } from "fastify";
import {
  lookupByCoords,
  lookupByNameAndCoords,
} from "../../../../integrations/geocoding/place-lookup.js";
import {
  deduplicatePhotos,
  searchHeroPhotos,
} from "../../../../integrations/photos/orchestrator.js";
import { fetchAggregate } from "../../../../integrations/reviews/orchestrator.js";
import { getPlaceKnowledge } from "../services/knowledge/index";
import { buildReviewLinks } from "../services/review-links";
import { TTL, withCache } from "../utils/cache.js";

/**
 * Merge Wikidata-sourced external identifiers (Yelp / TripAdvisor / Google
 * Maps / Foursquare / Instagram / Facebook, plus the OSM `wikidata` tag)
 * into `place.ids`. We only overlay — never overwrite — so producer-level
 * ids stay authoritative.
 */
function foldExternalIdsIntoPlace(
  place: Place,
  externalIds: Record<string, string> | undefined,
): Place {
  const ids: PlaceIds = { ...place.ids };
  const wd = place.osmTags?.wikidata;
  if (wd && !ids.wikidata) ids.wikidata = wd;
  if (externalIds) {
    if (externalIds.yelp && !ids.yelp) ids.yelp = externalIds.yelp;
    if (externalIds.tripadvisor && !ids.tripadvisor) ids.tripadvisor = externalIds.tripadvisor;
    if (externalIds.google_maps && !ids.googleMaps) ids.googleMaps = externalIds.google_maps;
    if (externalIds.foursquare && !ids.foursquare) ids.foursquare = externalIds.foursquare;
    if (externalIds.instagram && !ids.instagram) ids.instagram = externalIds.instagram;
    if (externalIds.facebook && !ids.facebook) ids.facebook = externalIds.facebook;
  }
  return { ...place, ids };
}

/**
 * Fetches Mangrove aggregate in a short window, returning null on timeout or
 * when the place has fewer than 3 reviews — too few to show a confident
 * rating summary. Never throws.
 */
async function safeAggregate(
  lat: number,
  lng: number,
  name: string,
): Promise<{ stars: number; count: number } | null> {
  if (!name) return null;
  try {
    const result = await Promise.race([
      fetchAggregate({ lat, lng, name }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 1500)),
    ]);
    if (!result || result.count < 3 || result.stars <= 0) return null;
    return { stars: result.stars, count: result.count };
  } catch {
    return null;
  }
}

/**
 * Knowledge + photos + review-links + Mangrove-aggregate pipeline applied
 * to every resolved Place, regardless of which scheme's resolver produced
 * it. Extracted so the resolver branch and the coord-fallback branch
 * share identical enrichment.
 */
async function enrichPlace(place: Place, lang: string | undefined): Promise<Place> {
  const {
    externalIds,
    photos: knowledgePhotos,
    ...knowledge
  } = await getPlaceKnowledge(place, lang);
  const enriched = foldExternalIdsIntoPlace(place, externalIds);
  const heroPhotos = enriched.osmTags ? await searchHeroPhotos(enriched.osmTags) : [];
  const photos = deduplicatePhotos([...heroPhotos, ...(knowledgePhotos ?? [])]);
  const [plng, plat] = enriched.coordinates;
  const reviewStats = await safeAggregate(plat, plng, enriched.name);
  return {
    ...enriched,
    ...knowledge,
    photos,
    reviewLinks: buildReviewLinks(enriched),
    rating: reviewStats?.stars,
    reviewCount: reviewStats?.count,
  };
}

interface PlaceByIdQuery {
  lat?: string;
  lng?: string;
  name?: string;
  lang?: string;
  hasAddress?: string;
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
          hasAddress: { type: "string" },
        },
      },
    },
    handler: async (req, reply) => {
      const rawId = decodeURIComponent(req.params.id);
      const lang = req.query.lang;
      const effectiveLang = lang ?? "en";
      const hasAddress = req.query.hasAddress === "1";
      const cacheKey = `cache:place:${rawId}:${effectiveLang}${hasAddress ? ":ha" : ""}`;

      try {
        const result = await withCache(cacheKey, TTL.places.detail, async () => {
          const parsedId = parseId(rawId);
          const latQ = Number.parseFloat(req.query.lat ?? "");
          const lngQ = Number.parseFloat(req.query.lng ?? "");
          const resolverCtx: PlaceResolverContext = {
            lang,
            lat: Number.isFinite(latQ) ? latQ : undefined,
            lng: Number.isFinite(lngQ) ? lngQ : undefined,
            hasAddress,
          };

          // Registered resolver dispatch — each scheme's owner integration
          // registers a resolver at boot (see `integrations/geocoding`,
          // `integrations/geocoding-db-ris`, and the per-provider data-source
          // resolvers registered via `createDataSourceResolver`).
          if (parsedId) {
            const resolver = getPlaceResolver(parsedId.scheme);
            if (resolver) {
              const resolved = await resolver(parsedId.value, resolverCtx);
              if (!resolved) {
                const err: CacheableError = {
                  statusCode: 404,
                  message: `No match for ${rawId}`,
                };
                throw err;
              }
              return enrichPlace(resolved, lang);
            }
          }

          // Coord-fallback path for schemes without a registered resolver
          // (saved-label handles, coordinate fallbacks, opaque deep-link
          // ids). Requires lat/lng/name — without them there's nothing to do.
          const lat = latQ;
          const lng = lngQ;
          const name = req.query.name?.trim() ?? "";

          if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
            const err: CacheableError = {
              statusCode: 400,
              message: "Non-resolvable place ID requires lat and lng query parameters",
            };
            throw err;
          }

          if (!name) {
            const err: CacheableError = {
              statusCode: 400,
              message: "Non-resolvable place ID requires lat, lng, and name query parameters",
            };
            throw err;
          }

          const place =
            (await lookupByNameAndCoords(name, lat, lng, rawId, lang)) ??
            (await lookupByCoords(lat, lng, rawId, lang));

          if (!place) {
            const err: CacheableError = {
              statusCode: 404,
              message: `No OSM match found near [${lat}, ${lng}]`,
            };
            throw err;
          }

          return enrichPlace(place, lang);
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
