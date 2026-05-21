import type {
  CreateKeypairEnvelopePayload,
  EnvelopeState,
  PlaceReviewsQuery,
  SubmitReviewTransportPayload,
  UpdateKeypairWrapsPayload,
  UploadReviewImagePayload,
} from "./types";

/**
 * Server-side contract the host application implements. Each method maps to
 * a single backend endpoint (or local storage, if the host wants to skip the
 * server entirely). Implementations should reject on non-2xx HTTP and return
 * the parsed JSON body on success.
 *
 * Hooks fetch typed review/aggregate shapes through generics so the host
 * controls the wire-format on its endpoint without leaking concrete types
 * into this package.
 */
export interface MangroveTransport<TReview = unknown, TAggregate = unknown> {
  /**
   * Fetch the server-side encrypted-or-cleartext keypair envelope.
   * Return `null` when the user has none yet (i.e. needs setup) — typically
   * mapped from a 204 No Content response.
   */
  getKeypairEnvelope(): Promise<EnvelopeState | null>;

  /** Create the envelope (first-time setup). */
  createKeypairEnvelope(payload: CreateKeypairEnvelopePayload): Promise<void>;

  /** Replace the wraps (add/remove unlock methods, change passphrase). */
  updateKeypairWraps(payload: UpdateKeypairWrapsPayload): Promise<void>;

  /** Wipe the envelope entirely (regenerate flow). */
  deleteKeypairEnvelope(): Promise<void>;

  /** Submit a signed review JWT. Returns the server-assigned id. */
  submitReview(payload: SubmitReviewTransportPayload): Promise<{ id: string }>;

  /** Upload a (already EXIF-stripped) image. Returns the absolute URL. */
  uploadReviewImage(payload: UploadReviewImagePayload): Promise<{ src: string }>;

  /** Fetch the full list of reviews for a place. */
  fetchPlaceReviews(query: PlaceReviewsQuery): Promise<TReview[]>;

  /** Fetch aggregate stars + count for a place. */
  fetchPlaceReviewAggregate(query: PlaceReviewsQuery): Promise<TAggregate>;
}

/**
 * Minimal current-user shape the hooks need. The host passes this in so the
 * keypair-state query has a stable cache key per user and the review composer
 * has a default nickname.
 */
export interface MangroveCurrentUser {
  /** Stable identifier for cache keying. */
  id: string;
  /** Display name fallback when a review submission doesn't override it. */
  nickname?: string | null;
}
