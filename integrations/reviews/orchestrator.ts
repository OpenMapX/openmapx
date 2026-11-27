import {
  captureReviewProviderContributors,
  collectOrderedProviders,
  type IntegrationContext,
} from "@openmapx/integration-framework";
import { normalizeOsmElementRef } from "@openmapx/mangrove-client";
import type {
  Review,
  ReviewAggregate,
  ReviewProvider,
  ReviewSubject,
} from "@openmapx/provider-kit/reviews";

/**
 * Review providers in the operator's order (unlisted ones in registration
 * order), each wrapped to credit the sources its integration declares.
 */
export function getReviewProviders(
  source: Pick<IntegrationContext, "getProviderOrder" | "getIntegrationsByDomain">,
): ReviewProvider[] {
  const integrations = new Map(
    source.getIntegrationsByDomain("reviews").map((integration) => [integration.id, integration]),
  );
  return collectOrderedProviders<ReviewProvider>(source, "reviews").flatMap(
    ({ integrationId, provider }) => {
      const integration = integrations.get(integrationId);
      return integration ? [captureReviewProviderContributors(integration, provider)] : [];
    },
  );
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

  // Keep each provider paired with its results so we can stamp `source` (the
  // provider that actually returned the review) — that's what lets the UI
  // credit only the sources whose reviews are shown rather than every
  // installed review provider.
  const settled = await Promise.allSettled(
    providers.map((p) => p.getReviews(subject).then((reviews) => ({ id: p.id, reviews }))),
  );
  const seen = new Set<string>();
  const merged: Review[] = [];
  for (const result of settled) {
    if (result.status !== "fulfilled") continue;
    for (const review of result.value.reviews) {
      if (seen.has(review.id)) continue;
      seen.add(review.id);
      merged.push(review.source ? review : { ...review, source: result.value.id });
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
  options?: { signal?: AbortSignal; strict?: boolean },
): Promise<ReviewAggregate> {
  const zero: ReviewAggregate = {
    count: 0,
    opinionCount: 0,
    positiveCount: 0,
    confirmedCount: 0,
    quality: 0,
    stars: 0,
  };
  let failure: unknown;
  let failed = false;
  let failurePriority = -2;
  for (const p of providers) {
    options?.signal?.throwIfAborted();
    try {
      const aggregate = await p.getAggregate(subject, options);
      // Stamp the producing provider so the UI credits the aggregate's source.
      return aggregate.source ? aggregate : { ...aggregate, source: p.id };
    } catch (error) {
      if (options?.signal?.aborted) throw error;
      const detail =
        error && typeof error === "object"
          ? (error as { status?: number; retryAfterMs?: number })
          : undefined;
      const status = detail?.status;
      const transient = status === undefined || status === 408 || status === 429 || status >= 500;
      const priority = transient
        ? Math.max(2000, Number.isFinite(detail?.retryAfterMs) ? (detail?.retryAfterMs ?? 0) : 0)
        : -1;
      if (!failed || priority > failurePriority) {
        failure = error;
        failurePriority = priority;
      }
      failed = true;
      // fall through to next provider
    }
  }
  if (options?.strict && failed) throw failure;
  return zero;
}

/** Forward a signed JWT to the first provider in order that accepts submissions. */
export async function submitReview(
  signedJwt: string,
  providers: ReviewProvider[],
): Promise<{ id: string }> {
  const p = providers.find((provider) => typeof provider.submit === "function");
  if (!p?.submit) throw new Error("No review provider supports submissions");
  return p.submit(signedJwt);
}

/** Upload an image through the first provider in order that accepts uploads. */
export async function uploadReviewImage(
  file: Blob,
  filename: string,
  providers: ReviewProvider[],
): Promise<{ src: string }> {
  const p = providers.find((provider) => typeof provider.uploadImage === "function");
  if (!p?.uploadImage) throw new Error("No review provider supports image uploads");
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

/** Receipt-bearing reads and post-write invalidation share one versioned namespace. */
export function reviewCacheKey(kind: "list" | "agg", subject: ReviewSubject): string {
  return `cache:reviews:contributors-v1:${kind}:${cacheKeyForSubject(subject)}`;
}
