import {
  deduplicatePhotos,
  getPhotoProviders,
  searchHeroPhotos,
} from "@integrations/photos/orchestrator";
import { fetchAggregate, getReviewProviders } from "@integrations/reviews/orchestrator";
import {
  type CategoryCardEnrichmentRequest,
  type CategoryCardEnrichmentResponse,
  categoryPlaceToPlace,
  isDisplayablePhoto,
  type PlacePhoto,
} from "@openmapx/core";
import { contributorsForRecords } from "@openmapx/mobility-core/contributors";
import { getAllIntegrations } from "../../integration-host.js";
import { isStaticImageHost } from "../../routes/image-hosts.js";
import { BoundedWorkQueue } from "../../utils/bounded-work-queue.js";
import { cacheGet, hashKey, TTL, withCache } from "../../utils/cache.js";
import { getPlaceKnowledge } from "../knowledge/index";
import { recordCardEnrichment } from "../metrics/index";

/** Card photo budget measured from admission; queue time counts toward it. */
export const CARD_DEADLINE_MS = 5_500;
const CARD_RATING_TIMEOUT_MS = 1_500;
const cardQueueOptions = {
  concurrency: 4,
  maxQueued: 32,
  maxPerClient: 16,
  cancelAbandoned: true,
} as const;
const cardPhotoQueue = new BoundedWorkQueue(cardQueueOptions);
const cardRatingQueue = new BoundedWorkQueue(cardQueueOptions);
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

/** One card-enrichment HTTP request: who is charged, when it gives up, and its disconnect. */
export interface CardRequest {
  client: string;
  deadlineAt: number;
  signal: AbortSignal;
}

function throwIfCoolingDown(key: string): void {
  const cooldown = cardFailureCooldown.get(key);
  if (!cooldown) return;
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

/**
 * Cached and cooling-down fields answer without using the queue. Everything
 * else is admitted against the global and per-network budget first, and
 * shares one execution with other callers asking for the same field.
 */
async function admitCardWork<T>(
  queue: BoundedWorkQueue,
  key: string,
  ttlSeconds: number,
  request: CardRequest,
  fetch: (signal: AbortSignal, deadlineAt: number) => Promise<T>,
): Promise<T> {
  throwIfCoolingDown(key);
  const cached = await cacheGet<T>(key);
  if (cached !== null) return cached;
  return queue.run(
    { key, client: request.client, deadlineAt: request.deadlineAt, signal: request.signal },
    (signal, deadlineAt) => withCardCache(key, ttlSeconds, signal, () => fetch(signal, deadlineAt)),
  );
}

async function withCardCache<T>(
  key: string,
  ttlSeconds: number,
  signal: AbortSignal,
  fn: () => Promise<T>,
): Promise<T> {
  throwIfCoolingDown(key);
  try {
    return await withCache(key, ttlSeconds, fn);
  } catch (error) {
    // Work cancelled because every caller left says nothing about the provider.
    const delay =
      signal.aborted || error instanceof AbandonedWorkSettling
        ? undefined
        : failureOutcome(error).retryAfterMs;
    if (delay) {
      cardFailureCooldown.set(key, { error, until: Date.now() + delay });
      if (cardFailureCooldown.size > 1024)
        cardFailureCooldown.delete(cardFailureCooldown.keys().next().value as string);
    }
    throw error;
  }
}

export function normalizeCardRequest(value: unknown): CategoryCardEnrichmentRequest | null {
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

/** Provider work that kept running after every caller of its card job left. */
const abandonedCardWork = new WeakSet<Promise<unknown>>();

/** Another caller's abandoned work outlived this caller's deadline; not a provider failure. */
class AbandonedWorkSettling extends Error {
  constructor() {
    super("Previous card request is still settling after its caller left");
  }
}

function markAbandoned(abandoned: AbortSignal, work: Promise<unknown>): void {
  abandoned.addEventListener("abort", () => abandonedCardWork.add(work), { once: true });
}

/**
 * A replacement job for a card whose previous caller left waits for that
 * aborted provider work to settle, so a disconnect never turns into a failure
 * and shared cooldown for the next caller.
 */
async function awaitAbandonedWork(
  pending: Map<string, Promise<unknown>>,
  key: string,
  abandoned: AbortSignal,
  deadlineAt: number,
): Promise<void> {
  const previous = pending.get(key);
  if (!previous || !abandonedCardWork.has(previous)) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      previous.then(
        () => undefined,
        () => undefined,
      ),
      abandonment(abandoned),
      new Promise((resolve) => {
        timer = setTimeout(resolve, Math.max(0, deadlineAt - Date.now()));
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (pending.get(key) === previous) throw new AbandonedWorkSettling();
}

/** Rejects once `signal` aborts, so abandoned work stops holding its queue slot. */
function abandonment(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

async function cardPhoto(
  input: CardInput,
  lang: string | undefined,
  request: CardRequest,
): Promise<PlacePhoto | null> {
  const tags = Object.fromEntries(
    Object.entries(input.photoTags ?? {}).sort(([left], [right]) => left.localeCompare(right)),
  ) as Record<string, string>;
  if (Object.keys(tags).length === 0) return null;
  const key = hashKey("cache:card-photo:v3", {
    id: input.id,
    coordinates: input.coordinates,
    name: input.name,
    lang,
    tags,
  });
  const { photo } = await admitCardWork(
    cardPhotoQueue,
    key,
    TTL.photos,
    request,
    async (abandoned, deadlineAt) => {
      await awaitAbandonedWork(pendingCardPhoto, key, abandoned, deadlineAt);
      if (pendingCardPhoto.has(key)) throw new Error("Previous photo request is still settling");
      if (pendingCardPhoto.size >= 4) throw new Error("Photo providers are still settling");
      const controller = new AbortController();
      abandoned.addEventListener("abort", () => controller.abort(abandoned.reason), { once: true });
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
      markAbandoned(abandoned, work);
      void work.then(() => {
        if (pendingCardPhoto.get(key) === work) pendingCardPhoto.delete(key);
      });
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const deadline = Symbol("photo deadline");
        const settled = await Promise.race([
          work,
          abandonment(abandoned),
          new Promise<typeof deadline>((resolve) => {
            timer = setTimeout(
              () => {
                const error = new Error("Photo deadline exceeded");
                controller.abort(error);
                resolve(deadline);
              },
              Math.max(0, deadlineAt - Date.now()),
            );
          }),
        ]);
        abandoned.throwIfAborted();
        if (settled === deadline) {
          const completedPhoto = deduplicatePhotos([
            ...completedHeroes,
            ...completedKnowledge,
          ]).find(proxyablePhoto);
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
        const photo =
          deduplicatePhotos([...heroes, ...knowledgePhotos]).find(proxyablePhoto) ?? null;
        if (!photo && failures.length > 0) {
          failures.sort(
            (left, right) =>
              (failureOutcome(right).retryAfterMs ?? -1) -
              (failureOutcome(left).retryAfterMs ?? -1),
          );
          throw failures[0];
        }
        return { photo };
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
  );
  return photo;
}

async function cardRating(
  input: CardInput,
  request: CardRequest,
): Promise<CardResult["rating"] | null> {
  const [lng, lat] = input.coordinates;
  const match = /^osm:(node|way|relation)\/(\d+)$/.exec(input.id);
  const subject = {
    lat,
    lng,
    name: input.name,
    osmId: match ? `${match[1]}/${match[2]}` : undefined,
  };
  const key = hashKey("cache:card-rating:v3-contributors", subject);
  const { rating } = await admitCardWork(
    cardRatingQueue,
    key,
    600,
    request,
    async (abandoned, deadlineAt) => {
      await awaitAbandonedWork(pendingCardRating, key, abandoned, deadlineAt);
      if (pendingCardRating.has(key)) throw new Error("Previous rating request is still settling");
      if (pendingCardRating.size >= 4) throw new Error("Rating providers are still settling");
      const controller = new AbortController();
      abandoned.addEventListener("abort", () => controller.abort(abandoned.reason), { once: true });
      let timer: ReturnType<typeof setTimeout> | undefined;
      const work = fetchAggregate(subject, getReviewProviders(getAllIntegrations()), {
        signal: controller.signal,
        strict: true,
      });
      pendingCardRating.set(key, work);
      markAbandoned(abandoned, work);
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
          abandonment(abandoned),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () => {
                const error = new Error("Rating deadline exceeded");
                controller.abort(error);
                reject(error);
              },
              Math.max(0, Math.min(CARD_RATING_TIMEOUT_MS, deadlineAt - Date.now())),
            );
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
          rating: {
            stars: aggregate.stars,
            count: ratedCount,
            source: aggregate.source,
            contributors: contributorsForRecords([aggregate]),
          },
        };
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
  );
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

export async function enrichCard(
  input: CardInput,
  lang: string | undefined,
  request: CardRequest,
): Promise<CardResult> {
  const fields = input.fields ?? ["photo", "rating"];
  const [photoResult, ratingResult] = await Promise.all([
    fields.includes("photo")
      ? cardPhoto(input, lang, request).then(
          (value) => ({ value }),
          (error) => ({ error }),
        )
      : Promise.resolve(undefined),
    fields.includes("rating")
      ? cardRating(input, request).then(
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
  // A caller that disconnected never sees these outcomes; they are not provider results.
  if (!request.signal.aborted) {
    if (outcomes.photo) recordCardEnrichment("photo", outcomes.photo.status);
    if (outcomes.rating) recordCardEnrichment("rating", outcomes.rating.status);
  }
  return { id: input.id, ...(photo ? { photo } : {}), ...(rating ? { rating } : {}), outcomes };
}
