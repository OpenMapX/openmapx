import type { Place } from "@openmapx/core";
import {
  CATEGORY_FILTERS,
  categoryPlaceToPlace,
  getPlaceResolver,
  haversineDistance,
  type OsmFilter,
  type PlaceIds,
  type PlaceResolverContext,
  parseId,
  searchByCategory,
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

interface NearbyPlacesQuery {
  lat?: string;
  lng?: string;
  radius?: string;
  excludeId?: string;
  lang?: string;
}

interface CacheableError {
  statusCode: number;
  message: string;
}

const DEFAULT_NEARBY_RADIUS_METRES = 1000;
const MIN_NEARBY_RADIUS_METRES = 50;
const MAX_NEARBY_RADIUS_METRES = 2500;
const NEARBY_LIMIT = 30;
const NEARBY_CACHE_TTL_SECONDS = TTL.places.nearby;

const NEARBY_CATEGORY_IDS = [
  "restaurants",
  "cafes",
  "bars",
  "supermarkets",
  "pharmacies",
  "atms",
  "parks",
  "museums",
  "activities",
  "hotels",
  "schools",
  "hospitals",
  "libraries",
  "cinemas",
  "gyms",
  "banks",
  "churches",
  "post_offices",
  "parking",
  "fuel",
  "ev_charging",
  "fire_stations",
  "police",
  "airports",
  "toilets",
  "drinking_water",
] as const;

function parseCoordinate(value: string | undefined, min: number, max: number): number | null {
  const parsed = Number.parseFloat(value ?? "");
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) return null;
  return parsed;
}

function parseRadius(value: string | undefined): number {
  const parsed = Number.parseFloat(value ?? "");
  if (!Number.isFinite(parsed)) return DEFAULT_NEARBY_RADIUS_METRES;
  return Math.min(MAX_NEARBY_RADIUS_METRES, Math.max(MIN_NEARBY_RADIUS_METRES, Math.round(parsed)));
}

function bboxFromRadius(lat: number, lng: number, radiusMetres: number) {
  const latDelta = radiusMetres / 111_320;
  const lngScale = Math.max(Math.cos((lat * Math.PI) / 180), 0.01);
  const lngDelta = radiusMetres / (111_320 * lngScale);
  return {
    west: Math.max(-180, lng - lngDelta),
    south: Math.max(-90, lat - latDelta),
    east: Math.min(180, lng + lngDelta),
    north: Math.min(90, lat + latDelta),
  };
}

function nearbyFilters(): OsmFilter[] {
  const seen = new Set<string>();
  return NEARBY_CATEGORY_IDS.flatMap((categoryId) => CATEGORY_FILTERS[categoryId] ?? []).filter(
    (filter) => {
      const key = `${filter.key}:${filter.value}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    },
  );
}

function roundForCache(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

export const placesRoute: FastifyPluginAsync = async (fastify) => {
  fastify.get<{
    Querystring: NearbyPlacesQuery;
  }>("/places", {
    schema: {
      querystring: {
        type: "object",
        properties: {
          lat: { type: "string" },
          lng: { type: "string" },
          radius: { type: "string" },
          excludeId: { type: "string" },
          lang: { type: "string" },
        },
      },
    },
    handler: async (req, reply) => {
      const lat = parseCoordinate(req.query.lat, -90, 90);
      const lng = parseCoordinate(req.query.lng, -180, 180);
      if (lat === null || lng === null) {
        return reply.status(400).send({ error: "lat and lng query parameters are required" });
      }

      const radiusMetres = parseRadius(req.query.radius);
      const center: [number, number] = [lng, lat];
      const excludeId = req.query.excludeId?.trim();
      const effectiveLang = req.query.lang ?? "en";
      const cacheKey = [
        "cache:places:nearby",
        roundForCache(lat),
        roundForCache(lng),
        radiusMetres,
        excludeId ?? "",
        effectiveLang,
      ].join(":");

      try {
        const places = await withCache(cacheKey, NEARBY_CACHE_TTL_SECONDS, async () => {
          const bbox = bboxFromRadius(lat, lng, radiusMetres);
          const candidates = await searchByCategory(nearbyFilters(), bbox);

          return candidates
            .filter((place) => place.id !== excludeId)
            .map((place) => ({
              place: categoryPlaceToPlace(place),
              distance: haversineDistance(center, place.coordinates),
            }))
            .filter(({ distance }) => distance <= radiusMetres)
            .sort((a, b) => a.distance - b.distance)
            .slice(0, NEARBY_LIMIT)
            .map(({ place }) => place);
        });

        reply.header("Cache-Control", `public, max-age=${NEARBY_CACHE_TTL_SECONDS}`);
        return places;
      } catch (err) {
        fastify.log.error({ err }, "Failed to fetch nearby places");
        return reply.status(500).send({ error: "Internal server error" });
      }
    },
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
