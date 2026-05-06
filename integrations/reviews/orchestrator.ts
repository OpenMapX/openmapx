import type { LoadedIntegration } from "@openmapx/core";
import { normalizeOsmElementRef } from "@openmapx/core";
import type { Review, ReviewAggregate, ReviewProvider, ReviewSubject } from "./types.js";

export function getReviewProviders(integrations: LoadedIntegration[]): ReviewProvider[] {
  const providers: ReviewProvider[] = [];
  for (const integration of integrations) {
    if (!integration.enabled || !integration.manifest.domains.includes("reviews")) continue;
    for (const p of (integration.providers.get("reviews") ?? []) as ReviewProvider[]) {
      providers.push(p);
    }
  }
  return providers;
}

/**
 * Merge reviews from all providers, deduplicated by id (= signature).
 * Sort newest-first.
 */
export async function fetchReviews(
  subject: ReviewSubject,
  providers: ReviewProvider[],
): Promise<Review[]> {
  if (providers.length === 0) return [];

  const settled = await Promise.allSettled(providers.map((p) => p.getReviews(subject)));
  const seen = new Set<string>();
  const merged: Review[] = [];
  for (const result of settled) {
    if (result.status !== "fulfilled") continue;
    for (const review of result.value) {
      if (seen.has(review.id)) continue;
      seen.add(review.id);
      merged.push(review);
    }
  }
  merged.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return merged;
}

/**
 * Fetch aggregate from the first available provider. Future work: merge multi-provider
 * aggregates weighted by confidence. Returns a zero-aggregate on total failure.
 */
export async function fetchAggregate(
  subject: ReviewSubject,
  providers: ReviewProvider[],
): Promise<ReviewAggregate> {
  const zero: ReviewAggregate = {
    count: 0,
    opinionCount: 0,
    positiveCount: 0,
    confirmedCount: 0,
    quality: 0,
    stars: 0,
  };
  for (const p of providers) {
    try {
      return await p.getAggregate(subject);
    } catch {
      // fall through to next provider
    }
  }
  return zero;
}

/** Forward a signed JWT to the primary provider. Throws if the provider can't submit. */
export async function submitReview(
  signedJwt: string,
  providers: ReviewProvider[],
): Promise<{ id: string }> {
  const p = providers[0];
  if (!p) throw new Error("No review providers registered");
  if (!p.submit) throw new Error(`Provider ${p.id} does not support submissions`);
  return p.submit(signedJwt);
}

/** Upload an image via the primary provider. */
export async function uploadReviewImage(
  file: Blob,
  filename: string,
  providers: ReviewProvider[],
): Promise<{ src: string }> {
  const p = providers[0];
  if (!p) throw new Error("No review providers registered");
  if (!p.uploadImage) throw new Error(`Provider ${p.id} does not support image uploads`);
  return p.uploadImage(file, filename);
}

/** Stable cache key segment from (lat, lng, name, optional OSM identity). */
export function cacheKeyForSubject(subject: ReviewSubject): string {
  const lat = subject.lat.toFixed(6);
  const lng = subject.lng.toFixed(6);
  const nameSlug = subject.name
    .trim()
    .toLowerCase()
    .replace(/[^\w]+/g, "-")
    .slice(0, 60);
  const osm = normalizeOsmElementRef(subject.osmId)?.replace("/", "-") ?? "no-osm";
  return `${lat}:${lng}:${nameSlug}:${osm}`;
}
