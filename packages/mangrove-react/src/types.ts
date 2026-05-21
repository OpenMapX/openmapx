/**
 * Server-side keypair envelope formats. The server stores either:
 *  - unencrypted: the private JWK in cleartext, or
 *  - encrypted: two age-armored ciphertexts of the same plaintext private JWK
 *    (`passphraseCiphertext` for scrypt-only, `recipientsCiphertext` for the
 *    WebAuthn-PRF recipient set), plus per-wrap metadata.
 */

export type KeypairEncryptionMode = "unencrypted" | "encrypted";
export type KeypairWrapType = "passphrase" | "webauthn";

export interface KeypairWrap {
  id: string;
  wrapType: KeypairWrapType;
  label: string;
  /** Age plugin identity string (`AGE-PLUGIN-FIDO2PRF-1...`). Null for passphrase wraps. */
  identityString: string | null;
  createdAt: string;
}

export interface KeypairEnvelopeUnencrypted {
  mode: "unencrypted";
  publicJwk: JsonWebKey;
  privateJwk: JsonWebKey;
}

export interface KeypairEnvelopeEncrypted {
  mode: "encrypted";
  publicJwk: JsonWebKey;
  passphraseCiphertext: string | null;
  recipientsCiphertext: string | null;
  wraps: KeypairWrap[];
}

export type KeypairEnvelope = KeypairEnvelopeUnencrypted | KeypairEnvelopeEncrypted;

export type EnvelopeState = { state: "uninitialized" } | (KeypairEnvelope & { state: "ready" });

/** Wire-format metadata about a single wrap (no secret material). */
export interface WrapMeta {
  wrapType: KeypairWrapType;
  label: string;
  identityString: string | null;
}

/** Payload sent to `transport.createKeypairEnvelope`. */
export type CreateKeypairEnvelopePayload =
  | {
      mode: "unencrypted";
      publicJwk: JsonWebKey;
      privateJwk: JsonWebKey;
    }
  | {
      mode: "encrypted";
      publicJwk: JsonWebKey;
      passphraseCiphertext: string | null;
      recipientsCiphertext: string | null;
      wraps: WrapMeta[];
    };

/** Payload sent to `transport.updateKeypairWraps`. */
export interface UpdateKeypairWrapsPayload {
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
