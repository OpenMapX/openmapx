import type {
  Review,
  ReviewAggregate,
  ReviewProvider,
  ReviewSubject,
} from "@openmapx/integration-reviews/types";
import {
  buildMangroveQueryUri,
  haversineDistanceMeters,
  normalizeMangrovePlaceName,
  normalizeOsmElementRef,
  parseMangroveGeoUri,
  REVIEW_MATCH_MAX_DISTANCE_METERS,
  REVIEW_NAMELESS_MATCH_MAX_DISTANCE_METERS,
  verifyMangroveReview,
} from "@openmapx/mangrove-client";
import { mangroveGetReviews, mangroveSubmit, mangroveUploadImage } from "./client.js";
import type { MangroveWirePayload, MangroveWireReview } from "./types.js";

const MARESI_PREFIX = "urn:maresi:";

/**
 * Mangrove records are self-authenticating, so only records whose signatures
 * and author keys verify are allowed into the review projection.
 */
const verificationStats = {
  checked: 0,
  verified: 0,
  failed: 0,
  reasons: {} as Record<string, number>,
};

/** Cumulative verification counters, readable by tests and operators. */
export function getMangroveVerificationStats(): {
  checked: number;
  verified: number;
  failed: number;
  reasons: Record<string, number>;
} {
  return { ...verificationStats, reasons: { ...verificationStats.reasons } };
}

export function resetMangroveVerificationStats(): void {
  verificationStats.checked = 0;
  verificationStats.verified = 0;
  verificationStats.failed = 0;
  verificationStats.reasons = {};
}

async function verifyWireReviews(wires: MangroveWireReview[]): Promise<MangroveWireReview[]> {
  const kept: MangroveWireReview[] = [];
  const failures: { signature: string; reason: string }[] = [];

  for (const wire of wires) {
    const result = await verifyMangroveReview({
      jwt: wire.jwt,
      signature: wire.signature,
      kid: wire.kid,
    });
    verificationStats.checked += 1;
    if (result.ok) {
      verificationStats.verified += 1;
      // The signed body is the only trustworthy copy; the sibling `payload`
      // and `kid` fields are whatever the server chose to send. `original_sub`
      // is server-derived and not signed, so it is carried through as-is.
      kept.push({
        ...wire,
        kid: result.kid,
        payload: result.payload as unknown as MangroveWirePayload,
      });
      continue;
    }
    verificationStats.failed += 1;
    verificationStats.reasons[result.reason] = (verificationStats.reasons[result.reason] ?? 0) + 1;
    failures.push({ signature: wire.signature.slice(0, 12), reason: result.reason });
  }

  if (failures.length > 0) {
    console.warn(
      `[reviews-mangrove] signature verification failed for ${failures.length}/${wires.length} records`,
      { samples: failures.slice(0, 3) },
    );
  }

  return kept;
}

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

  const license =
    metadata.license === "CC-BY-SA-4.0"
      ? "CC-BY-SA-4.0"
      : metadata.license === "CC-BY-4.0"
        ? "CC-BY-4.0"
        : undefined;

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
      license,
    },
  };
}

function wireSubjectForPlaceMatch(wire: MangroveWireReview): string | undefined {
  const sub = wire.payload?.sub;
  if (typeof sub !== "string") return undefined;
  if (sub.startsWith("geo:")) return sub;
  if (sub.startsWith(MARESI_PREFIX) && typeof wire.original_sub === "string") {
    return wire.original_sub;
  }
  return undefined;
}

/**
 * Mangrove's `/reviews?sub=geo:...` filter is `is_spatially_close OR sub
 * ILIKE '%q=NAME%'`, so dropping `q=` from our query URI removes the global
 * name-match path. Even so, we tighten with our own haversine cap because:
 *  - reviews submitted with very large `u` can match well beyond our place;
 *  - upstream radius is `stored_u + query_u`, which we want to bound.
 *
 * `urn:maresi:` action records (edit/delete) carry no geo in `payload.sub`;
 * Mangrove returns their reviewed place in `original_sub` when they appear in
 * a geo-subject query, so we match against that original subject.
 *
 * Spatial closeness is necessary but not sufficient. Dense map areas can have
 * unrelated POIs inside one another's uncertainty radius, so non-action
 * reviews also need either matching OSM metadata or, when OSM metadata is
 * incomplete, a matching `geo:` `q=` place name. Records without either
 * identity signal only attach at a very small distance.
 */
function isWireReviewWithinSubject(wire: MangroveWireReview, subject: ReviewSubject): boolean {
  const sub = wireSubjectForPlaceMatch(wire);
  if (!sub) return false;
  if (!sub.startsWith("geo:")) return false;
  const parsed = parseMangroveGeoUri(sub);
  if (!parsed) return false;
  const dist = haversineDistanceMeters(
    { lat: parsed.lat, lng: parsed.lng },
    { lat: subject.lat, lng: subject.lng },
  );
  if (dist > REVIEW_MATCH_MAX_DISTANCE_METERS) return false;

  const reviewOsmId = normalizeOsmElementRef(wire.payload.metadata?.osm_id);
  const subjectOsmId = normalizeOsmElementRef(subject.osmId);
  if (reviewOsmId && subjectOsmId) return reviewOsmId === subjectOsmId;

  const reviewName = normalizeMangrovePlaceName(parsed.name);
  const subjectName = normalizeMangrovePlaceName(subject.name);
  if (reviewName && subjectName) return reviewName === subjectName;

  return dist <= REVIEW_NAMELESS_MATCH_MAX_DISTANCE_METERS;
}

function mergeMetadata(
  original: Review["metadata"],
  update: Review["metadata"],
): Review["metadata"] {
  const merged: Review["metadata"] = { ...(original ?? {}) };
  for (const [key, value] of Object.entries(update ?? {})) {
    if (value !== undefined) {
      (merged as Record<string, unknown>)[key] = value;
    }
  }
  return merged;
}

function normalizeReviewAuthorNickname(nickname: string | undefined): string | undefined {
  const normalized = nickname?.normalize("NFKC").trim().toLowerCase();
  return normalized ? normalized : undefined;
}

function dedupKeyForEffectiveReview(review: Review): string {
  const nickname = normalizeReviewAuthorNickname(review.author.nickname);
  return nickname ? `${review.author.kid}\n${nickname}` : review.author.kid;
}

function isNewerReview(candidate: Review, current: Review): boolean {
  const candidateTime = Date.parse(candidate.createdAt);
  const currentTime = Date.parse(current.createdAt);
  if (candidateTime !== currentTime) return candidateTime > currentTime;
  return candidate.id > current.id;
}

/**
 * Collapse duplicate original reviews after action projection. OpenMapX treats
 * a place review as the author's current opinion for that place; imported
 * sources can still contain several original records for one author/place
 * without using Mangrove's edit chain. Keeping the newest effective review
 * prevents one author/source-account from voting multiple times.
 *
 * The nickname participates in the key because imported reviews may be signed
 * by one importer key while preserving the original reviewer only as metadata.
 */
function collapseDuplicateEffectiveReviews(reviews: Review[]): Review[] {
  const byAuthor = new Map<string, Review>();

  for (const review of reviews) {
    const key = dedupKeyForEffectiveReview(review);
    const current = byAuthor.get(key);
    if (!current || isNewerReview(review, current)) {
      byAuthor.set(key, review);
    }
  }

  return Array.from(byAuthor.values());
}

/**
 * Collapse a Mangrove review chain (originals + action records) to one effective
 * record per original-id. Per Mangrove spec:
 *  - `edit` replaces the original's displayable fields (rating, opinion, images, …).
 *  - `delete` removes the target from display entirely.
 *  - edit/delete MUST be signed by the same verified keypair as the original.
 *
 * Mangrove's geo-sub response with `latest_edits_only` (default true) returns
 * the latest edit record instead of the original. We fetch original records
 * as a companion read when actions are present so partial edits can preserve
 * original fields such as images. If that companion read fails, an edit whose
 * `original_sub` matched the place is still shown as a best-effort effective
 * review under the original review id.
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
    if (!original) {
      if (m.action === "edit") {
        effective.set(m.targetId, {
          ...m,
          id: m.targetId,
          action: undefined,
          targetId: undefined,
        });
      }
      continue;
    }
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
        metadata: mergeMetadata(original.metadata, m.metadata),
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
    const latest = await mangroveGetReviews(sub, { limit: 200 });
    const hasAction = latest.reviews.some(
      (r) => r.payload.action && r.payload.sub?.startsWith(MARESI_PREFIX),
    );
    const originalReviews = hasAction
      ? await mangroveGetReviews(sub, { limit: 200, latestEditsOnly: false })
          .then((r) => r.reviews)
          .catch(() => [])
      : [];
    const seen = new Set<string>();
    const reviews = [...originalReviews, ...latest.reviews].filter((r) => {
      if (seen.has(r.signature)) return false;
      seen.add(r.signature);
      return true;
    });
    const verified = await verifyWireReviews(reviews);
    const mapped = verified
      .filter((r) => isWireReviewWithinSubject(r, subject))
      .map((r) => toReview(subject, r));
    return collapseDuplicateEffectiveReviews(applyMutations(mapped));
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
