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
import { getAllIntegrations, isEnabledIntegrationScheme } from "../integration-host.js";
import { getPlaceKnowledge } from "../services/knowledge/index";
import { buildReviewLinks } from "../services/review-links";
import { TTL, withCache } from "../utils/cache.js";
import { createLimiter } from "../utils/concurrency.js";

// Bound concurrent place enrichments. Each enrichPlace runs a heavy fan-out
// (knowledge sources, photo + review providers, and sometimes multi-MB OSM
// boundary polygons); a burst of DISTINCT place opens would otherwise run N of
// them at once and OOM the process. Identical requests already coalesce in
// withCache, so this caps only the distinct ones. Tunable for high-memory hosts.
const ENRICH_CONCURRENCY = Math.trunc(Number(process.env.OPENMAPX_PLACE_ENRICH_CONCURRENCY)) || 8;
const enrichLimit = createLimiter(Math.max(1, ENRICH_CONCURRENCY));

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
  // Fall back to brand:wikidata (chain outlets often carry only that) so the
  // Wikidata reference still surfaces — e.g. a Shell station with brand:wikidata
  // but no place-level wikidata tag.
  const wd = place.osmTags?.wikidata ?? place.osmTags?.["brand:wikidata"];
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
    // Overture GERS id — surfaces as an "Overture Maps" external reference,
    // crediting the source whenever Overture enrichment matched the place.
    if (externalIds.gers && !ids.gers) {
      ids.gers = externalIds.gers;
    }
  }
  const osmTripadvisor = place.osmTags?.["contact:tripadvisor"];
  if (osmTripadvisor && !ids.tripadvisor && buildTripadvisorUrl(osmTripadvisor)) {
    ids.tripadvisor = osmTripadvisor;
  }
  return { ...place, ids };
}

/** Maps a social-profile URL to its OSM `contact:*` tag key, or null if unsupported. Exported for testing. */
export function socialContactTag(url: string): string | null {
  let host: string;
  try {
    host = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
  if (host === "facebook.com" || host === "m.facebook.com" || host === "fb.com") {
    return "contact:facebook";
  }
  if (host === "instagram.com") return "contact:instagram";
  if (host === "twitter.com" || host === "x.com") return "contact:twitter";
  if (host === "youtube.com" || host === "youtu.be") return "contact:youtube";
  if (host === "linkedin.com") return "contact:linkedin";
  if (host === "t.me" || host === "telegram.me") return "contact:telegram";
  if (host === "pinterest.com") return "contact:pinterest";
  if (host === "reddit.com") return "contact:reddit";
  return null;
}

/**
 * Gap-fills OSM `contact:<platform>` tags from knowledge-source social URLs
 * (e.g. Overture `socials`) so they render in the place panel's social row.
 * OSM values are never overwritten.
 */
function applyKnowledgeSocials(
  osmTags: Record<string, string> | undefined,
  socials: string[] | undefined,
): Record<string, string> | undefined {
  if (!socials?.length) return osmTags;
  const out = { ...(osmTags ?? {}) };
  for (const url of socials) {
    const tag = socialContactTag(url);
    if (tag && !out[tag]) out[tag] = url;
  }
  return out;
}

function websitePathDepth(url: string): number {
  try {
    const path = new URL(url).pathname.replace(/\/+$/, "");
    return path === "" ? 0 : path.split("/").filter(Boolean).length;
  } catch {
    return 0;
  }
}

// Aggregator / directory hosts that should never win the website slot over an
// OSM-curated URL, even if their path looks more specific.
const WEBSITE_AGGREGATOR_HOSTS = new Set([
  "lieferando.de",
  "ubereats.com",
  "wolt.com",
  "booking.com",
  "opentable.com",
  "thefork.com",
  "facebook.com",
  "instagram.com",
  "google.com",
  "business.site",
  "linktr.ee",
  "yelp.com",
  "tripadvisor.com",
]);

/**
 * Picks the more specific of two website URLs by path depth — a deep outlet
 * link (e.g. find.shell.com/de/fuel/<store>) beats a bare brand homepage
 * (shell.de/). Returns whichever is present; ties keep the OSM URL; an
 * aggregator/directory host never displaces an OSM-curated URL. Exported for testing.
 */
export function pickMoreSpecificWebsite(
  osm: string | undefined,
  other: string | undefined,
): string | undefined {
  if (!other) return osm;
  if (!osm) return other;
  let otherHost: string;
  try {
    otherHost = new URL(other).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return osm;
  }
  if (WEBSITE_AGGREGATOR_HOSTS.has(otherHost)) return osm;
  return websitePathDepth(other) > websitePathDepth(osm) ? other : osm;
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
    phone: knowledgePhone,
    website: knowledgeWebsite,
    socials: knowledgeSocials,
    ...knowledge
  } = await getPlaceKnowledge(place, lang);
  const enriched = foldExternalIdsIntoPlace(place, externalIds);

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
  const [plng, plat] = enriched.coordinates;

  // The three downstream calls are mutually independent: run them in parallel.
  // fetchOsmBoundary is gated on boundary=administrative so we never pull
  // polygons for POIs — only admin areas get a boundary highlight.
  // If a future step consumes another step's output, move it outside this call.
  const [adminBoundary, heroPhotos, reviewStats] = await Promise.all([
    enriched.osmTags?.boundary === "administrative" && enriched.ids?.osm
      ? fetchOsmBoundary(enriched.ids.osm, lang)
      : Promise.resolve(null),
    enriched.osmTags ? searchHeroPhotos(enriched.osmTags, photoProviders) : Promise.resolve([]),
    safeAggregate(plat, plng, enriched.name, enriched.ids?.osm, reviewProviders),
  ]);
  const photos = deduplicatePhotos([...heroPhotos, ...(knowledgePhotos ?? [])]);
  return {
    ...enriched,
    ...knowledge,
    // Social profiles: gap-fill the OSM `contact:*` tags from a knowledge
    // source so they render in the existing social-links row.
    osmTags: applyKnowledgeSocials(enriched.osmTags, knowledgeSocials),
    // Contact details: OSM is fresher, so phone wins; for the website, prefer
    // the more specific URL (a deep outlet link beats a bare brand homepage).
    phone: enriched.phone ?? knowledgePhone,
    website: pickMoreSpecificWebsite(enriched.website, knowledgeWebsite),
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
              return enrichLimit(() => enrichPlace(resolved, lang));
            }
            // No resolver registered for this scheme. The coord-fallback
            // below would happily snap to the nearest OSM POI — fine for
            // freeform UI schemes (saved labels, basemap POI clicks,
            // Street View drops) that aren't backed by any integration,
            // dangerous for an integration whose `setup()` failed and
            // never got to register its resolver. The manifest registry
            // tells us which is which: any scheme matching an installed
            // integration id is strict; everything else is freeform.
            if (isEnabledIntegrationScheme(parsedId.scheme)) {
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

          return enrichLimit(() => enrichPlace(place, lang));
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
