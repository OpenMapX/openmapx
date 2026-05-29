import {
  fetchOsmBoundary,
  lookupByCoords,
  lookupByNameAndCoords,
} from "@integrations/geocoding/place-lookup";
import {
  deduplicatePhotos,
  getPhotoProviders,
  searchHeroPhotos,
} from "@integrations/photos/orchestrator";
import { fetchAggregate, getReviewProviders } from "@integrations/reviews/orchestrator";
import type { Place, ReviewProvider } from "@openmapx/core";
import { type PlaceIds, parseId } from "@openmapx/core";
import { buildOpeningHoursInfo } from "@openmapx/core/server";
import {
  buildFacebookUrl,
  buildFoursquareUrl,
  buildGoogleMapsUrl,
  buildInstagramUrl,
  buildTripadvisorUrl,
  buildYelpUrl,
  getPlaceResolver,
  type PlaceResolverContext,
} from "@openmapx/place-ids";
import type { FastifyPluginAsync } from "fastify";
import { getAllIntegrations, isIntegrationScheme } from "../integration-host.js";
import { getPlaceKnowledge } from "../services/knowledge/index";
import { buildReviewLinks } from "../services/review-links";
import { TTL, withCache } from "../utils/cache.js";

/**
 * Merge external identifiers (Wikidata-sourced Yelp / Tripadvisor / Google
 * Maps / Foursquare / Instagram / Facebook, the OSM `wikidata` tag, and safe
 * OSM Tripadvisor links) into `place.ids`. We only overlay — never overwrite —
 * so producer-level ids stay authoritative.
 */
function foldExternalIdsIntoPlace(
  place: Place,
  externalIds: Record<string, string> | undefined,
): Place {
  const ids: PlaceIds = { ...place.ids };
  const wd = place.osmTags?.wikidata;
  if (wd && !ids.wikidata) ids.wikidata = wd;
  if (externalIds) {
    if (externalIds.yelp && !ids.yelp && buildYelpUrl(externalIds.yelp)) {
      ids.yelp = externalIds.yelp;
    }
    if (
      externalIds.tripadvisor &&
      !ids.tripadvisor &&
      buildTripadvisorUrl(externalIds.tripadvisor)
    ) {
      ids.tripadvisor = externalIds.tripadvisor;
    }
    if (externalIds.google_maps && !ids.googleMaps && buildGoogleMapsUrl(externalIds.google_maps)) {
      ids.googleMaps = externalIds.google_maps;
    }
    if (externalIds.foursquare && !ids.foursquare && buildFoursquareUrl(externalIds.foursquare)) {
      ids.foursquare = externalIds.foursquare;
    }
    if (externalIds.instagram && !ids.instagram && buildInstagramUrl(externalIds.instagram)) {
      ids.instagram = externalIds.instagram;
    }
    if (externalIds.facebook && !ids.facebook && buildFacebookUrl(externalIds.facebook)) {
      ids.facebook = externalIds.facebook;
    }
  }
  const osmTripadvisor = place.osmTags?.["contact:tripadvisor"];
  if (osmTripadvisor && !ids.tripadvisor && buildTripadvisorUrl(osmTripadvisor)) {
    ids.tripadvisor = osmTripadvisor;
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
  osmId: string | undefined,
  providers: ReviewProvider[],
): Promise<{ stars: number; count: number } | null> {
  if (!name) return null;
  try {
    const result = await Promise.race([
      fetchAggregate({ lat, lng, name, osmId }, providers),
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

  // For administrative areas (cities, regions, countries), fetch the real OSM
  // boundary outline so the client can draw a dashed border and fit the map to
  // the whole area — mirroring Google Maps' city highlight. Gated on the
  // `boundary=administrative` OSM tag so we never pull polygons for POIs.
  const adminBoundary =
    enriched.osmTags?.boundary === "administrative" && enriched.ids?.osm
      ? await fetchOsmBoundary(enriched.ids.osm, lang)
      : null;

  if (enriched.openingHours && !enriched.openingHoursInfo) {
    enriched.openingHoursInfo = buildOpeningHoursInfo(enriched.openingHours, {
      lat: enriched.coordinates[1],
      lon: enriched.coordinates[0],
      countryCode: enriched.countryCode,
    });
  }
  const allIntegrations = getAllIntegrations();
  const photoProviders = getPhotoProviders(allIntegrations);
  const reviewProviders = getReviewProviders(allIntegrations);
  const heroPhotos = enriched.osmTags
    ? await searchHeroPhotos(enriched.osmTags, photoProviders)
    : [];
  const photos = deduplicatePhotos([...heroPhotos, ...(knowledgePhotos ?? [])]);
  const [plng, plat] = enriched.coordinates;
  const reviewStats = await safeAggregate(
    plat,
    plng,
    enriched.name,
    enriched.ids?.osm,
    reviewProviders,
  );
  return {
    ...enriched,
    ...knowledge,
    photos,
    reviewLinks: buildReviewLinks(enriched),
    rating: reviewStats?.stars,
    reviewCount: reviewStats?.count,
    boundary: adminBoundary?.boundary,
    boundingBox: adminBoundary?.boundingBox,
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
            const resolver = getPlaceResolver<Place>(parsedId.scheme);
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
            // No resolver registered for this scheme. The coord-fallback
            // below would happily snap to the nearest OSM POI — fine for
            // freeform UI schemes (saved labels, basemap POI clicks,
            // Street View drops) that aren't backed by any integration,
            // dangerous for an integration whose `setup()` failed and
            // never got to register its resolver. The manifest registry
            // tells us which is which: any scheme matching an installed
            // integration id is strict; everything else is freeform.
            if (isIntegrationScheme(parsedId.scheme)) {
              fastify.log.warn(
                { scheme: parsedId.scheme, rawId },
                "places: integration scheme has no resolver; refusing coord-fallback",
              );
              const err: CacheableError = {
                statusCode: 404,
                message: `No resolver for scheme '${parsedId.scheme}'`,
              };
              throw err;
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
