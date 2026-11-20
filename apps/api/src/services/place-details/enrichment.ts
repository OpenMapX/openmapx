import { fetchOsmBoundary } from "@integrations/geocoding/place-lookup";
import {
  deduplicatePhotos,
  getPhotoProviders,
  searchHeroPhotos,
} from "@integrations/photos/orchestrator";
import { fetchAggregate, getReviewProviders } from "@integrations/reviews/orchestrator";
import {
  createRequestJsonScope,
  type Place,
  type ReviewAggregate,
  type ReviewProvider,
} from "@openmapx/core";
import { contributorsForField, contributorsForRecords } from "@openmapx/mobility-core/contributors";
import { getAllIntegrations } from "../../integration-host.js";
import { BoundedWorkQueue } from "../../utils/bounded-work-queue.js";
import { getPlaceKnowledge } from "../knowledge/index";
import { buildReviewLinks } from "../review-links";
import { captureEnrichedPlaceContributors } from "./contributors.js";
import {
  applyKnowledgeContactTags,
  applyKnowledgeSocials,
  foldExternalIdsIntoPlace,
  mergePlaceProvenance,
  pickMoreSpecificWebsite,
} from "./merge.js";

// Bound concurrent place enrichments. Each enrichPlace runs a heavy fan-out
// (knowledge sources, photo + review providers, and sometimes multi-MB OSM
// boundary polygons); a burst of DISTINCT place opens would otherwise run N of
// them at once and OOM the process. Identical requests coalesce onto one
// execution, so this caps only the distinct ones. Tunable for high-memory hosts.
const ENRICH_CONCURRENCY = Math.max(
  1,
  Math.trunc(Number(process.env.OPENMAPX_PLACE_ENRICH_CONCURRENCY)) || 8,
);
if (!Number.isFinite(ENRICH_CONCURRENCY)) {
  throw new Error("OPENMAPX_PLACE_ENRICH_CONCURRENCY must be finite");
}
/** The place client stops waiting after 20 seconds, so queue time and work share this budget. */
export const PLACE_DETAIL_DEADLINE_MS = 20_000;
// Every provider in one enrichment shares the execution's signal, so the
// request-local JSON scope stays shareable and abandoned work stops upstream.
export const placeEnrichQueue = new BoundedWorkQueue({
  concurrency: ENRICH_CONCURRENCY,
  maxQueued: ENRICH_CONCURRENCY * 4,
  maxPerClient: 16,
  cancelAbandoned: true,
});

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
  signal: AbortSignal,
): Promise<Pick<ReviewAggregate, "stars" | "count" | "contributors"> | null> {
  if (!name) return null;
  try {
    const result = await Promise.race([
      fetchAggregate({ lat, lng, name, osmId }, providers, { signal }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 1500)),
    ]);
    if (!result || result.count < 3 || result.stars <= 0) return null;
    return {
      stars: result.stars,
      count: result.count,
      contributors: contributorsForRecords([result]),
    };
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
export async function enrichPlace(
  place: Place,
  lang: string | undefined,
  signal: AbortSignal,
): Promise<Place> {
  const allIntegrations = getAllIntegrations();
  const photoProviders = getPhotoProviders(allIntegrations);
  const reviewProviders = getReviewProviders(allIntegrations);
  const [plng, plat] = place.coordinates;
  // One scope per full enrichment: knowledge and hero photos share identical
  // Wikimedia JSON, and it is released with this call. Never wired into card
  // mode. Every consumer shares the scope's one signal.
  const jsonScope = createRequestJsonScope({ signal });

  // These inputs do not depend on knowledge's auxiliary IDs. Start all four
  // branches together, then fold those IDs into the final response.
  const [knowledgeResult, adminBoundary, heroPhotos, reviewStats] = await Promise.all([
    getPlaceKnowledge(place, lang, { jsonScope, signal }),
    // Only administrative areas get a boundary highlight.
    place.osmTags?.boundary === "administrative" && place.ids?.osm
      ? fetchOsmBoundary(place.ids.osm, lang, signal)
      : Promise.resolve(null),
    place.osmTags
      ? searchHeroPhotos(place.osmTags, photoProviders, { getJson: jsonScope.getJson, signal })
      : Promise.resolve([]),
    safeAggregate(plat, plng, place.name, place.ids?.osm, reviewProviders, signal),
  ]);
  // Providers degrade to empty results when cancelled; never cache that as the place.
  signal.throwIfAborted();
  const {
    externalIds,
    photos: knowledgePhotos,
    phone: knowledgePhone,
    email: knowledgeEmail,
    website: knowledgeWebsite,
    socials: knowledgeSocials,
    address: knowledgeAddress,
    addressEvidence: knowledgeAddressEvidence,
    city: knowledgeCity,
    countryCode: knowledgeCountryCode,
    provenance: knowledgeProvenance,
    ...knowledge
  } = knowledgeResult;
  const enriched = foldExternalIdsIntoPlace(place, externalIds);
  const photos = deduplicatePhotos([...heroPhotos, ...(knowledgePhotos ?? [])]);
  const result: Place = {
    ...enriched,
    ...knowledge,
    // Social profiles: gap-fill the OSM `contact:*` tags from a knowledge
    // source so they render in the existing social-links row.
    osmTags: applyKnowledgeContactTags(
      applyKnowledgeSocials(enriched.osmTags, knowledgeSocials),
      knowledgeEmail,
      knowledge.brand,
    ),
    // Contact details: OSM is fresher, so phone wins; for the website, prefer
    // the more specific URL (a deep outlet link beats a bare brand homepage).
    phone: enriched.phone ?? knowledgePhone,
    email: enriched.email ?? knowledgeEmail,
    website: pickMoreSpecificWebsite(enriched.website, knowledgeWebsite),
    socials: enriched.socials ?? knowledgeSocials,
    address: enriched.address || knowledgeAddress || "",
    addressEvidence: enriched.address
      ? enriched.addressEvidence
      : knowledgeAddress
        ? (knowledgeAddressEvidence ?? {
            source: contributorsForField(knowledgeResult, "address")[0]?.sourceId ?? "knowledge",
            method: "provider-label",
            components: {},
          })
        : undefined,
    city: enriched.city ?? knowledgeCity,
    countryCode: enriched.countryCode ?? knowledgeCountryCode,
    provenance: mergePlaceProvenance(enriched.provenance, knowledgeProvenance),
    photos,
    reviewLinks: buildReviewLinks(enriched),
    rating: reviewStats?.stars,
    reviewCount: reviewStats?.count,
    boundary: adminBoundary?.boundary,
    boundingBox: adminBoundary?.boundingBox,
  };
  return captureEnrichedPlaceContributors(
    place,
    knowledgeResult,
    result,
    reviewStats,
    adminBoundary,
  );
}
