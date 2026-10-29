/** Encrypted-only server envelope contracts. */

export type KeypairWrapType = "passphrase" | "webauthn";

/**
 * Preflight mirror of the API's authoritative encrypted-keypair wrap limit.
 * Keep this value aligned with `apps/api/src/routes/reviews-keypair.ts`.
 */
export const MAX_KEYPAIR_WRAPS = 32;

export interface KeypairWrap {
  id: string;
  wrapType: KeypairWrapType;
  label: string;
  /** Age plugin identity string (`AGE-PLUGIN-FIDO2PRF-1...`). Null for passphrase wraps. */
  identityString: string | null;
  createdAt: string;
}

export interface KeypairEnvelopeEncrypted {
  revision: string;
  publicJwk: JsonWebKey;
  passphraseCiphertext: string | null;
  recipientsCiphertext: string | null;
  wraps: KeypairWrap[];
}
export type KeypairEnvelope = KeypairEnvelopeEncrypted;

/** A stale local operation must be surfaced without fetching and retrying. */
export class MangroveConflictError extends Error {
  readonly status = 409;
  constructor() {
    super("Keypair changed. Refresh and unlock again.");
    this.name = "MangroveConflictError";
  }
}

export type EnvelopeState = { state: "uninitialized" } | (KeypairEnvelope & { state: "ready" });

/** Wire-format metadata about a single wrap (no secret material). */
export interface WrapMeta {
  wrapType: KeypairWrapType;
  label: string;
  identityString: string | null;
}

/** Payload sent to `transport.createKeypairEnvelope`. */
export interface CreateKeypairEnvelopePayload {
  publicJwk: JsonWebKey;
  passphraseCiphertext: string | null;
  recipientsCiphertext: string | null;
  wraps: WrapMeta[];
}

/** Payload sent to `transport.updateKeypairWraps`. */
export interface UpdateKeypairWrapsPayload {
  expectedRevision: string;
  passphraseCiphertext: string | null;
  recipientsCiphertext: string | null;
  wraps: WrapMeta[];
}

/** Query shape for fetching a place's reviews / aggregate. */
export interface PlaceReviewsQuery {
  lat: number;
  lng: number;
  name: string;
  osmId?: string;
}

/** Payload for `transport.submitReview`. */
export interface SubmitReviewTransportPayload {
  /** The signed Mangrove JWT (Mangrove's wire format). */
  jwt: string;
  /** Place coordinates + name so the server can invalidate the right caches. */
  invalidate: PlaceReviewsQuery;
}

/** Payload for `transport.uploadReviewImage`. Already-stripped image as data URL. */
export interface UploadReviewImagePayload {
  dataUrl: string;
  filename: string;
}
