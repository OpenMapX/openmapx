import { buildMangroveSubjectUri } from "@openmapx/core";
import type { Review, ReviewAggregate, ReviewProvider, ReviewSubject } from "../reviews/types.js";
import {
  mangroveGetReviews,
  mangroveGetSubject,
  mangroveSubmit,
  mangroveUploadImage,
} from "./client.js";
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
 * Collapse a Mangrove review chain (originals + action records) to one effective
 * record per original-id. Per Mangrove spec:
 *  - `edit` replaces the original's displayable fields (rating, opinion, images, …).
 *  - `delete` removes the target from display entirely.
 *  - edit/delete MUST be signed by the same keypair as the original.
 *
 * Note on Mangrove's response shape: the public API already deduplicates a
 * review chain in geo-sub queries — for an edited review, only the LATEST edit
 * record is returned (the original and intermediate edits are elided). That
 * means an edit can arrive without its referenced original in our mutation
 * list; we treat that edit as the authoritative record and key it by its
 * `targetId` so subsequent edits line up.
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

    // If the original is present, enforce the same-author rule before letting
    // the mutation through. If the server already elided the original, we
    // trust the mutation at face value — Mangrove itself enforces the
    // signing-key match on write.
    if (original && original.author.kid !== m.author.kid) continue;

    if (m.action === "delete") {
      effective.delete(m.targetId);
    } else if (m.action === "edit") {
      const merged: Review = original
        ? {
            ...original,
            rating: m.rating ?? original.rating,
            stars: m.stars ?? original.stars,
            opinion: m.opinion ?? original.opinion,
            images: m.images ?? original.images,
            createdAt: m.createdAt,
            metadata: { ...original.metadata, ...m.metadata },
          }
        : { ...m, id: m.targetId, action: undefined, targetId: undefined };
      effective.set(m.targetId, merged);
    }
    // "report_abuse" and "equivalence" don't change display here.
  }

  return Array.from(effective.values());
}

export const mangroveProvider: ReviewProvider = {
  id: "mangrove",
  name: "Mangrove.reviews",

  async getReviews(subject: ReviewSubject): Promise<Review[]> {
    // Mangrove's geo-sub query already includes edit/delete records whose
    // `original_sub` resolves to this geo URI, so one round trip is enough.
    const sub = buildMangroveSubjectUri(subject);
    const { reviews } = await mangroveGetReviews(sub, { limit: 200 });
    const mapped = reviews.map((r) => toReview(subject, r));
    return applyMutations(mapped);
  },

  async getAggregate(subject: ReviewSubject): Promise<ReviewAggregate> {
    const sub = buildMangroveSubjectUri(subject);
    try {
      const s = await mangroveGetSubject(sub);
      // `quality` is null for tiny aggregates; fall back to a straight average
      // over the reviews if we need to. For now, return 0 stars — the UI
      // computes an average from the review list anyway.
      const quality = typeof s.quality === "number" ? s.quality : 0;
      return {
        count: s.count,
        opinionCount: s.opinion_count,
        positiveCount: s.positive_count,
        confirmedCount: s.confirmed_count,
        quality,
        stars: quality / 20,
      };
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
