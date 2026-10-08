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
import {
  buildPlaceDetailsRequest,
  type CategoryCardEnrichmentRequest,
  type CategoryCardEnrichmentResponse,
  categoryPlaceToPlace,
  isDisplayablePhoto,
  openingHoursSourceFromOsm,
  type Place,
  type PlaceIds,
  type PlacePhoto,
  parseId,
  type ReviewProvider,
} from "@openmapx/core";
import { ambientPlaceToCategoryPlace } from "@openmapx/core/ambient-places";
import { readAmbientPlaceByGers } from "@openmapx/core/ambient-places-server";
import { currentOpeningHoursInfo } from "@openmapx/core/server";
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
import { sql } from "../db/index.js";
import { getAllIntegrations, isEnabledIntegrationScheme } from "../integration-host.js";
import { getPlaceKnowledge } from "../services/knowledge/index";
import { recordCardEnrichment } from "../services/metrics/index";
import { buildReviewLinks } from "../services/review-links";
import { hashKey, TTL, withCache } from "../utils/cache.js";
import { createLimiter } from "../utils/concurrency.js";
import { declareRouteAuth } from "../utils/route-auth.js";
import { isStaticImageHost } from "./image-hosts.js";

// Bound concurrent place enrichments. Each enrichPlace runs a heavy fan-out
// (knowledge sources, photo + review providers, and sometimes multi-MB OSM
// boundary polygons); a burst of DISTINCT place opens would otherwise run N of
// them at once and OOM the process. Identical requests already coalesce in
// withCache, so this caps only the distinct ones. Tunable for high-memory hosts.
const ENRICH_CONCURRENCY = Math.trunc(Number(process.env.OPENMAPX_PLACE_ENRICH_CONCURRENCY)) || 8;
const enrichLimit = createLimiter(Math.max(1, ENRICH_CONCURRENCY));
const cardEnrichLimit = createLimiter(4);
const pendingCardRating = new Map<string, Promise<unknown>>();
const pendingCardPhoto = new Map<string, Promise<unknown>>();
const cardFailureCooldown = new Map<string, { error: unknown; until: number }>();
const CARD_PHOTO_TAGS = new Set([
  "image",
  "image:0",
  "image:1",
  "wikimedia_commons",
  "wikidata",
  "wikipedia",
]);
const WIKIPEDIA_LANGUAGE_RE = /^[a-z]{2,12}(?:-[a-z0-9]{1,12})*$/i;

function validWikipediaTag(tag: string): boolean {
  const colon = tag.indexOf(":");
  if (colon < 0) return true;
  const language = tag.slice(0, colon);
  return (
    language.length <= 32 &&
    WIKIPEDIA_LANGUAGE_RE.test(language) &&
    Boolean(tag.slice(colon + 1).trim())
  );
}

type CardInput = CategoryCardEnrichmentRequest["places"][number];
type CardResult = CategoryCardEnrichmentResponse["results"][number];

async function withCardCache<T>(key: string, ttlSeconds: number, fn: () => Promise<T>): Promise<T> {
  const cooldown = cardFailureCooldown.get(key);
  if (cooldown) {
    const remaining = cooldown.until - Date.now();
    if (remaining > 0) {
      const previous = cooldown.error as { status?: number; message?: string };
      throw Object.assign(new Error(previous?.message ?? "Card provider cooling down"), {
        status: previous?.status,
        retryAfterMs: remaining,
      });
    }
    cardFailureCooldown.delete(key);
  }
  try {
    return await withCache(key, ttlSeconds, fn);
  } catch (error) {
    const delay = failureOutcome(error).retryAfterMs;
    if (delay) {
      cardFailureCooldown.set(key, { error, until: Date.now() + delay });
      if (cardFailureCooldown.size > 1024)
        cardFailureCooldown.delete(cardFailureCooldown.keys().next().value as string);
    }
    throw error;
  }
}

function normalizeCardRequest(value: unknown): CategoryCardEnrichmentRequest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some((key) => key !== "places" && key !== "lang")) return null;
  if (!Array.isArray(body.places) || body.places.length < 1 || body.places.length > 8) return null;
  if (
    body.lang !== undefined &&
    (typeof body.lang !== "string" ||
      body.lang.length > 12 ||
      !WIKIPEDIA_LANGUAGE_RE.test(body.lang))
  )
    return null;
  const seen = new Set<string>();
  const places: CardInput[] = [];
  for (const raw of body.places) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const row = raw as Record<string, unknown>;
    if (
      Object.keys(row).some(
        (key) =>
          key !== "id" &&
          key !== "name" &&
          key !== "coordinates" &&
          key !== "photoTags" &&
          key !== "fields",
      ) ||
      typeof row.id !== "string" ||
      !row.id.trim() ||
      row.id.length > 200 ||
      typeof row.name !== "string" ||
      !row.name.trim() ||
      row.name.length > 200 ||
      !Array.isArray(row.coordinates) ||
      row.coordinates.length !== 2
    )
      return null;
    const [lng, lat] = row.coordinates;
    if (
      typeof lng !== "number" ||
      typeof lat !== "number" ||
      !Number.isFinite(lng) ||
      !Number.isFinite(lat) ||
      Math.abs(lng) > 180 ||
      Math.abs(lat) > 90
    )
      return null;
    const id = row.id.trim();
    if (seen.has(id)) return null;
    seen.add(id);
    if (
      row.fields !== undefined &&
      (!Array.isArray(row.fields) ||
        row.fields.length < 1 ||
        row.fields.length > 2 ||
        new Set(row.fields).size !== row.fields.length ||
        row.fields.some((field) => field !== "photo" && field !== "rating"))
    )
      return null;
    let photoTags: CardInput["photoTags"];
    if (row.photoTags !== undefined) {
      if (!row.photoTags || typeof row.photoTags !== "object" || Array.isArray(row.photoTags))
        return null;
      const entries = Object.entries(row.photoTags);
      if (entries.length > 6) return null;
      photoTags = {};
      for (const [key, rawTag] of entries) {
        if (!CARD_PHOTO_TAGS.has(key) || typeof rawTag !== "string" || !rawTag.trim()) return null;
        const tag = rawTag.trim();
        if (tag.length > (key.startsWith("image") ? 4096 : 512)) return null;
        if (key.startsWith("image")) {
          if (tag.startsWith("File:") ? !tag.slice(5).trim() : !validHttpUrl(tag)) return null;
        } else if (key === "wikidata" && !/^Q[1-9]\d*$/.test(tag)) return null;
        else if (key === "wikimedia_commons" && !/^(?:File|Category):\S/.test(tag)) return null;
        else if (key === "wikipedia" && !validWikipediaTag(tag)) return null;
        photoTags[key as keyof NonNullable<CardInput["photoTags"]>] = tag;
      }
    }
    places.push({
      id,
      name: row.name.trim(),
      coordinates: [lng, lat],
      photoTags,
      fields: row.fields as CardInput["fields"],
    });
  }
  return { places, lang: body.lang as string | undefined };
}

function validHttpUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return (
      (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password
    );
  } catch {
    return false;
  }
}

function proxyablePhoto(photo: PlacePhoto): boolean {
  const urls = [photo.url, photo.thumbnailUrl].filter((url): url is string => Boolean(url));
  return (
    Boolean(photo.source) &&
    isDisplayablePhoto(photo) &&
    urls.every((raw) => {
      if (!validHttpUrl(raw)) return false;
      return isStaticImageHost(new URL(raw).hostname);
    })
  );
}

async function cardPhoto(input: CardInput, lang: string | undefined): Promise<PlacePhoto | null> {
  const tags = Object.fromEntries(
    Object.entries(input.photoTags ?? {}).sort(([left], [right]) => left.localeCompare(right)),
  ) as Record<string, string>;
  if (Object.keys(tags).length === 0) return null;
  const key = hashKey("cache:card-photo", {
    id: input.id,
    coordinates: input.coordinates,
    name: input.name,
    lang,
    tags,
  });
  const { photo } = await withCardCache(key, TTL.photos, async () => {
    if (pendingCardPhoto.has(key)) throw new Error("Previous photo request is still settling");
    if (pendingCardPhoto.size >= 4) throw new Error("Photo providers are still settling");
    const controller = new AbortController();
    const failures: unknown[] = [];
    let completedHeroes: PlacePhoto[] = [];
    let completedKnowledge: PlacePhoto[] = [];
    const work = Promise.allSettled([
      searchHeroPhotos(tags, getPhotoProviders(getAllIntegrations()), {
        strict: true,
        signal: controller.signal,
        onError: (error) => failures.push(error),
        onPhotos: (photos) => completedHeroes.push(...photos),
      }).then((photos) => {
        completedHeroes = photos;
        return photos;
      }),
      tags.wikidata || tags.wikipedia
        ? getPlaceKnowledge(categoryPlaceToPlace({ ...input, osmTags: tags }), lang, {
            cardPhoto: true,
            signal: controller.signal,
            onError: (error) => failures.push(error),
            onPhotos: (photos) => completedKnowledge.push(...photos),
          }).then((result) => {
            completedKnowledge = result.photos ?? [];
            return result;
          })
        : Promise.resolve({ photos: [] }),
    ]);
    pendingCardPhoto.set(key, work);
    void work.then(() => {
      if (pendingCardPhoto.get(key) === work) pendingCardPhoto.delete(key);
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const deadline = Symbol("photo deadline");
      const settled = await Promise.race([
        work,
        new Promise<typeof deadline>((resolve) => {
          timer = setTimeout(() => {
            const error = new Error("Photo deadline exceeded");
            controller.abort(error);
            resolve(deadline);
          }, 5500);
        }),
      ]);
      if (settled === deadline) {
        const completedPhoto = deduplicatePhotos([...completedHeroes, ...completedKnowledge]).find(
          proxyablePhoto,
        );
        if (completedPhoto) return { photo: completedPhoto };
        let knownDelay = 0;
        let knownFailure: unknown;
        for (const failure of failures) {
          const delay = failureOutcome(failure).retryAfterMs ?? 0;
          if (delay > knownDelay) {
            knownDelay = delay;
            knownFailure = failure;
          }
        }
        if (knownDelay > 0) throw knownFailure;
        throw controller.signal.reason;
      }
      const [heroResult, knowledgeResult] = settled;
      const heroes = heroResult.status === "fulfilled" ? heroResult.value : [];
      const knowledgePhotos =
        knowledgeResult.status === "fulfilled" ? (knowledgeResult.value.photos ?? []) : [];
      if (heroResult.status === "rejected") failures.push(heroResult.reason);
      if (knowledgeResult.status === "rejected") failures.push(knowledgeResult.reason);
      const photo = deduplicatePhotos([...heroes, ...knowledgePhotos]).find(proxyablePhoto) ?? null;
      if (!photo && failures.length > 0) {
        failures.sort(
          (left, right) =>
            (failureOutcome(right).retryAfterMs ?? -1) - (failureOutcome(left).retryAfterMs ?? -1),
        );
        throw failures[0];
      }
      return { photo };
    } finally {
      if (timer) clearTimeout(timer);
    }
  });
  return photo;
}

async function cardRating(input: CardInput): Promise<CardResult["rating"] | null> {
  const [lng, lat] = input.coordinates;
  const match = /^osm:(node|way|relation)\/(\d+)$/.exec(input.id);
  const subject = {
    lat,
    lng,
    name: input.name,
    osmId: match ? `${match[1]}/${match[2]}` : undefined,
  };
  const key = hashKey("cache:card-rating", subject);
  const { rating } = await withCardCache(key, 600, async () => {
    if (pendingCardRating.has(key)) throw new Error("Previous rating request is still settling");
    if (pendingCardRating.size >= 4) throw new Error("Rating providers are still settling");
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const work = fetchAggregate(subject, getReviewProviders(getAllIntegrations()), {
      signal: controller.signal,
      strict: true,
    });
    pendingCardRating.set(key, work);
    void work.then(
      () => {
        if (pendingCardRating.get(key) === work) pendingCardRating.delete(key);
      },
      () => {
        if (pendingCardRating.get(key) === work) pendingCardRating.delete(key);
      },
    );
    try {
      const aggregate = await Promise.race([
        work,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            const error = new Error("Rating deadline exceeded");
            controller.abort(error);
            reject(error);
          }, 1500);
        }),
      ]);
      const ratedCount = aggregate?.ratedCount;
      if (
        !aggregate ||
        !Number.isFinite(aggregate.stars) ||
        aggregate.stars <= 0 ||
        aggregate.stars > 5 ||
        typeof ratedCount !== "number" ||
        !Number.isInteger(ratedCount) ||
        ratedCount < 3 ||
        !Number.isInteger(aggregate.count) ||
        ratedCount > aggregate.count ||
        !aggregate.source
      )
        return { rating: null };
      return {
        rating: { stars: aggregate.stars, count: ratedCount, source: aggregate.source },
      };
    } finally {
      if (timer) clearTimeout(timer);
    }
  });
  return rating;
}

function failureOutcome(error: unknown): { status: "failed"; retryAfterMs?: number } {
  const detail =
    error && typeof error === "object"
      ? (error as { status?: number; retryAfterMs?: number })
      : undefined;
  const status = detail?.status;
  const transient = status === undefined || status === 408 || status === 429 || status >= 500;
  if (!transient) return { status: "failed" };
  return {
    status: "failed",
    retryAfterMs: Math.max(
      2000,
      Number.isFinite(detail?.retryAfterMs) ? (detail?.retryAfterMs ?? 0) : 0,
    ),
  };
}

async function enrichCard(input: CardInput, lang: string | undefined): Promise<CardResult> {
  const fields = input.fields ?? ["photo", "rating"];
  const [photoResult, ratingResult] = await Promise.all([
    fields.includes("photo")
      ? cardPhoto(input, lang).then(
          (value) => ({ value }),
          (error) => ({ error }),
        )
      : Promise.resolve(undefined),
    fields.includes("rating")
      ? cardRating(input).then(
          (value) => ({ value }),
          (error) => ({ error }),
        )
      : Promise.resolve(undefined),
  ]);
  const photo = photoResult && "value" in photoResult ? photoResult.value : null;
  const rating = ratingResult && "value" in ratingResult ? ratingResult.value : null;
  const outcomes: NonNullable<CardResult["outcomes"]> = {};
  if (photoResult)
    outcomes.photo =
      "error" in photoResult
        ? failureOutcome(photoResult.error)
        : { status: photo ? "available" : "absent" };
  if (ratingResult)
    outcomes.rating =
      "error" in ratingResult
        ? failureOutcome(ratingResult.error)
        : { status: rating ? "available" : "absent" };
  if (outcomes.photo) recordCardEnrichment("photo", outcomes.photo.status);
  if (outcomes.rating) recordCardEnrichment("rating", outcomes.rating.status);
  return { id: input.id, ...(photo ? { photo } : {}), ...(rating ? { rating } : {}), outcomes };
}

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

function applyKnowledgeContactTags(
  osmTags: Record<string, string> | undefined,
  email: string | undefined,
  brand: Place["brand"],
): Record<string, string> | undefined {
  if (!email && !brand) return osmTags;
  const out = { ...(osmTags ?? {}) };
  if (email && !out.email && !out["contact:email"]) out.email = email;
  if (brand?.name && !out.brand) out.brand = brand.name;
  if (brand?.wikidata && !out["brand:wikidata"]) out["brand:wikidata"] = brand.wikidata;
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
  const allIntegrations = getAllIntegrations();
  const photoProviders = getPhotoProviders(allIntegrations);
  const reviewProviders = getReviewProviders(allIntegrations);
  const [plng, plat] = place.coordinates;

  // These inputs do not depend on knowledge's auxiliary IDs. Start all four
  // branches together, then fold those IDs into the final response.
  const [knowledgeResult, adminBoundary, heroPhotos, reviewStats] = await Promise.all([
    getPlaceKnowledge(place, lang),
    // Only administrative areas get a boundary highlight.
    place.osmTags?.boundary === "administrative" && place.ids?.osm
      ? fetchOsmBoundary(place.ids.osm, lang)
      : Promise.resolve(null),
    place.osmTags ? searchHeroPhotos(place.osmTags, photoProviders) : Promise.resolve([]),
    safeAggregate(plat, plng, place.name, place.ids?.osm, reviewProviders),
  ]);
  const {
    externalIds,
    photos: knowledgePhotos,
    phone: knowledgePhone,
    email: knowledgeEmail,
    website: knowledgeWebsite,
    socials: knowledgeSocials,
    address: knowledgeAddress,
    city: knowledgeCity,
    countryCode: knowledgeCountryCode,
    provenance: knowledgeProvenance,
    ...knowledge
  } = knowledgeResult;
  const enriched = foldExternalIdsIntoPlace(place, externalIds);
  const photos = deduplicatePhotos([...heroPhotos, ...(knowledgePhotos ?? [])]);
  return {
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
}

function mergePlaceProvenance(
  first: Place["provenance"],
  second: Place["provenance"],
): Place["provenance"] {
  const combined = [...(first ?? []), ...(second ?? [])];
  if (combined.length === 0) return undefined;
  const seen = new Set<string>();
  return combined.filter((source) => {
    const key = `${source.sourceId}|${source.dataset}|${source.property ?? ""}|${source.recordId ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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
  declareRouteAuth(fastify, "public");

  fastify.post<{ Body: unknown }>("/places/card-enrichment", {
    bodyLimit: 128 * 1024,
    handler: async (req, reply) => {
      const body = normalizeCardRequest(req.body);
      if (!body) return reply.status(400).send({ error: "Invalid card enrichment request" });
      const results = await Promise.all(
        body.places.map((place) => cardEnrichLimit(() => enrichCard(place, body.lang))),
      );
      return { results } satisfies CategoryCardEnrichmentResponse;
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
      const rawId = req.params.id;
      const lang = req.query.lang;
      const hasAddress = req.query.hasAddress === "1";
      const latInput = Number.parseFloat(req.query.lat ?? "");
      const lngInput = Number.parseFloat(req.query.lng ?? "");
      const placeRequest = buildPlaceDetailsRequest({
        id: rawId,
        coordinates:
          Number.isFinite(latInput) && Number.isFinite(lngInput) ? [lngInput, latInput] : undefined,
        name: req.query.name,
        lang,
        hasAddress,
      });
      // The shared canonical identity contains every normalized input that can
      // affect resolution or enrichment. Hash the structured value so
      // unconstrained string fields cannot create separator collisions.
      try {
        const parsed = parseId(rawId);
        const published =
          parsed?.scheme === "overture" && !getPlaceResolver("overture")
            ? await readAmbientPlaceByGers(sql, parsed.value)
            : null;
        const cacheKey = hashKey(
          "cache:place",
          published
            ? { ...placeRequest.identity, ambientGeneration: published.generation }
            : placeRequest.identity,
        );
        const result = await withCache(cacheKey, TTL.places.detail, async () => {
          const parsedId = parseId(rawId);
          const latQ = placeRequest.identity.lat ?? Number.NaN;
          const lngQ = placeRequest.identity.lng ?? Number.NaN;
          const resolverCtx: PlaceResolverContext = {
            lang: placeRequest.identity.lang ?? undefined,
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
              return enrichLimit(() =>
                enrichPlace(resolved, placeRequest.identity.lang ?? undefined),
              );
            }
            // The optional search provider may be disabled. An ambient
            // publication still owns its GERS identity; never snap that record
            // to a neighboring OSM object through coordinate fallback.
            if (published) {
              return enrichLimit(() =>
                enrichPlace(
                  categoryPlaceToPlace(
                    ambientPlaceToCategoryPlace(
                      published.place,
                      placeRequest.identity.lang ?? "en",
                    ),
                  ),
                  placeRequest.identity.lang ?? undefined,
                ),
              );
            }
            // No resolver registered for this scheme. The coord-fallback
            // below would happily snap to the nearest OSM POI — fine for
            // freeform UI schemes (saved labels, basemap POI clicks,
            // street-level imagery drops) that aren't backed by any integration,
            // dangerous for an integration whose `setup()` failed and
            // never got to register its resolver. The manifest registry
            // tells us which is which: any scheme matching an installed
            // integration id is strict; everything else is freeform.
            if (isEnabledIntegrationScheme(parsedId.scheme)) {
              fastify.log.warn(
                { scheme: parsedId.scheme },
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
          const name = placeRequest.identity.name ?? "";

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
            (await lookupByNameAndCoords(
              name,
              lat,
              lng,
              rawId,
              placeRequest.identity.lang ?? undefined,
            )) ?? (await lookupByCoords(lat, lng, rawId, placeRequest.identity.lang ?? undefined));

          if (!place) {
            const err: CacheableError = {
              statusCode: 404,
              message: `No OSM match found near [${lat}, ${lng}]`,
            };
            throw err;
          }

          return enrichLimit(() => enrichPlace(place, placeRequest.identity.lang ?? undefined));
        });
        const openingHoursInfo = await currentOpeningHoursInfo(result.openingHours, {
          lat: result.coordinates[1],
          lon: result.coordinates[0],
          countryCode: result.countryCode,
        });
        reply.header("Cache-Control", "no-store");
        const openingHoursSource = result.openingHours
          ? (result.openingHoursSource ?? openingHoursSourceFromOsm(result.id, result.osmTags))
          : undefined;
        const current = { ...result, openingHoursInfo, openingHoursSource };
        return current.photos
          ? { ...current, photos: current.photos.filter(isDisplayablePhoto) }
          : current;
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
