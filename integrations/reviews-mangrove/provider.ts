import {
  buildMangroveQueryUri,
  haversineDistanceMeters,
  parseMangroveGeoUri,
  REVIEW_MATCH_MAX_DISTANCE_METERS,
} from "@openmapx/core";
import type { Review, ReviewAggregate, ReviewProvider, ReviewSubject } from "../reviews/types.js";
import { mangroveGetReviews, mangroveSubmit, mangroveUploadImage } from "./client.js";
import type { MangroveWirePayload, MangroveWireReview } from "./types.js";

const MARESI_PREFIX = "urn:maresi:";

function toReview(subject: ReviewSubject, wire: MangroveWireReview): Review {
  const payload = wire.payload;
  const metadata = payload.metadata ?? {};
  const createdAt = new Date(payload.iat * 1000).toISOString();
  let action: Review["action"];
  let targetId: string | undefined;
  if (payload.action) {
    action = payload.action;
    if (payload.sub?.startsWith(MARESI_PREFIX)) {
      targetId = payload.sub.slice(MARESI_PREFIX.length);
    }
  }

  const stars = payload.rating !== undefined ? payload.rating / 20 : undefined;

  return {
    id: wire.signature,
    subject,
    rating: payload.rating,
    stars,
    opinion: payload.opinion,
    images: payload.images?.map((i) => ({ src: i.src, label: i.label })),
    author: {
      kid: wire.kid,
      nickname: metadata.nickname,
    },
    createdAt,
    action,
    targetId,
    metadata: {
      osmId: metadata.osm_id,
      clientId: metadata.client_id,
      experienceContext: metadata.experience_context,
      isAffiliated: metadata.is_affiliated,
      license: metadata.license === "CC-BY-SA-4.0" ? "CC-BY-SA-4.0" : "CC-BY-4.0",
    },
  };
}

/**
 * Mangrove's `/reviews?sub=geo:...` filter is `is_spatially_close OR sub
 * ILIKE '%q=NAME%'`, so dropping `q=` from our query URI removes the global
 * name-match path. Even so, we tighten with our own haversine cap because:
 *  - reviews submitted with very large `u` can match well beyond our place;
 *  - upstream radius is `stored_u + query_u`, which we want to bound.
 *
 * `urn:maresi:` action records (edit/delete) carry no geo of their own — we
 * keep them here and let `applyMutations` drop ones whose target wasn't
 * spatially-matched.
 */
function isWireReviewWithinSubject(wire: MangroveWireReview, subject: ReviewSubject): boolean {
  const sub = wire.payload?.sub;
  if (typeof sub !== "string") return false;
  if (sub.startsWith(MARESI_PREFIX)) return true;
  if (!sub.startsWith("geo:")) return false;
  const parsed = parseMangroveGeoUri(sub);
  if (!parsed) return false;
  const dist = haversineDistanceMeters(
    { lat: parsed.lat, lng: parsed.lng },
    { lat: subject.lat, lng: subject.lng },
  );
  return dist <= REVIEW_MATCH_MAX_DISTANCE_METERS;
}

/**
 * Collapse a Mangrove review chain (originals + action records) to one effective
 * record per original-id. Per Mangrove spec:
 *  - `edit` replaces the original's displayable fields (rating, opinion, images, …).
 *  - `delete` removes the target from display entirely.
 *  - edit/delete MUST be signed by the same keypair as the original.
 *
 * Mangrove's geo-sub response with `latest_edits_only` (default true) can
 * elide originals when their latest edit is what's returned. We previously
 * trusted such orphan mutations at face value, but now that we explicitly
 * spatial-filter originals, an absent original means the target is outside
 * our radius — so we drop the orphan rather than synthesizing a phantom
 * review at the queried location.
 */
function applyMutations(reviews: Review[]): Review[] {
  const effective = new Map<string, Review>();

  for (const r of reviews) {
    if (!r.action) effective.set(r.id, r);
  }

  const mutations = reviews
    .filter((r) => r.action && r.targetId)
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));

  for (const m of mutations) {
    if (!m.targetId) continue;
    const original = effective.get(m.targetId);
    if (!original) continue;
    if (original.author.kid !== m.author.kid) continue;

    if (m.action === "delete") {
      effective.delete(m.targetId);
    } else if (m.action === "edit") {
      effective.set(m.targetId, {
        ...original,
        rating: m.rating ?? original.rating,
        stars: m.stars ?? original.stars,
        opinion: m.opinion ?? original.opinion,
        images: m.images ?? original.images,
        createdAt: m.createdAt,
        metadata: { ...original.metadata, ...m.metadata },
      });
    }
    // "report_abuse" and "equivalence" don't change display here.
  }

  return Array.from(effective.values());
}

/**
 * Compute aggregate stats locally from the already-filtered review list.
 *
 * Why not call `/subject/{sub}`? That endpoint applies the same flawed
 * spatial-OR-name match as `/reviews`, so its `count` and `quality` for a
 * `geo:` subject can include reviews from completely different branches of
 * the same chain. Computing locally over our spatially-filtered set is the
 * only way to get correct numbers per place.
 */
function aggregateFromReviews(reviews: Review[]): ReviewAggregate {
  let opinionCount = 0;
  let positiveCount = 0;
  let ratingSum = 0;
  let ratingCount = 0;

  for (const r of reviews) {
    if (r.opinion) opinionCount += 1;
    if (typeof r.rating === "number") {
      ratingCount += 1;
      ratingSum += r.rating;
      if (r.rating >= 50) positiveCount += 1;
    }
  }

  const quality = ratingCount > 0 ? ratingSum / ratingCount : 0;
  return {
    count: reviews.length,
    opinionCount,
    positiveCount,
    // Confirmation count needs maresi-subject join we don't fetch here; the
    // UI doesn't surface it for individual places, so 0 is acceptable.
    confirmedCount: 0,
    quality,
    stars: quality / 20,
  };
}

export const mangroveProvider: ReviewProvider = {
  id: "mangrove",
  name: "Mangrove.reviews",

  async getReviews(subject: ReviewSubject): Promise<Review[]> {
    // Query without `q=NAME` so Mangrove's spatial-OR-name filter doesn't
    // bleed in same-named reviews from across the world. The post-filter
    // below tightens the upstream `stored_u + query_u` radius to a sane cap.
    const sub = buildMangroveQueryUri(subject);
    const { reviews } = await mangroveGetReviews(sub, { limit: 200 });
    const mapped = reviews
      .filter((r) => isWireReviewWithinSubject(r, subject))
      .map((r) => toReview(subject, r));
    return applyMutations(mapped);
  },

  async getAggregate(subject: ReviewSubject): Promise<ReviewAggregate> {
    // Compute from the spatially-filtered review list; `/subject/{sub}` has
    // the same flawed matching as `/reviews` and would over-count.
    try {
      const reviews = await mangroveProvider.getReviews(subject);
      return aggregateFromReviews(reviews);
    } catch {
      return {
        count: 0,
        opinionCount: 0,
        positiveCount: 0,
        confirmedCount: 0,
        quality: 0,
        stars: 0,
      };
    }
  },

  async submit(signedJwt: string): Promise<{ id: string }> {
    // Extract signature from the signed JWT for our return value.
    const parts = signedJwt.split(".");
    if (parts.length !== 3) throw new Error("Invalid JWT structure");
    await mangroveSubmit(signedJwt);
    // The signature segment is also the review id in Mangrove.
    return { id: parts[2] };
  },

  async uploadImage(file: Blob, filename: string): Promise<{ src: string }> {
    const src = await mangroveUploadImage(file, filename);
    return { src };
  },
};

/** Exported for hinting payload shape on callers. */
export type { MangroveWirePayload };
