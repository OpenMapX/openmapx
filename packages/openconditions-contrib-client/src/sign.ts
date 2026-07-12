import { toBase64Url } from "./base64url.js";
import type { DeviceKey } from "./device.js";
import { boundedCanonicalBytes } from "./jcs.js";
import { normalizeLowS } from "./lowS.js";
import type { ReportClaim, SignedReport, SignedSubClaim, SubClaimBody } from "./types.js";
import { validateReportClaim, validateSubClaimBody } from "./validate.js";

/** WebCrypto ES256 signing parameters (ECDSA P-256 + SHA-256). */
const ECDSA_SIGN_PARAMS = { name: "ECDSA", hash: "SHA-256" } as const;

/**
 * Sign a report claim: ES256 (WebCrypto ECDSA P-256 + SHA-256) over the claim's
 * RFC 8785 canonical bytes, normalized to the canonical low-S form. The
 * returned envelope embeds the public JWK for first submission; a server that
 * already caches the key may drop it. Mirrors @openconditions/contrib-core's
 * `signReport` so the envelope verifies there byte-for-byte.
 *
 * @throws TypeError when the claim violates the wire contract or exceeds the
 *   64 KiB canonical size cap.
 */
export async function signReport(claim: ReportClaim, key: DeviceKey): Promise<SignedReport> {
  const bytes = boundedCanonicalBytes(claim, "claim");
  validateReportClaim(claim);
  const raw = await globalThis.crypto.subtle.sign(ECDSA_SIGN_PARAMS, key.privateKey, bytes);
  return {
    alg: "ES256",
    keyId: key.keyId,
    pubJwk: key.publicJwk,
    claim,
    signature: toBase64Url(normalizeLowS(new Uint8Array(raw) as Uint8Array<ArrayBuffer>)),
  };
}

/**
 * Sign a sub-claim body: ES256 over the body's RFC 8785 canonical bytes — the
 * body WITHOUT alg/keyId/pubJwk/signature — normalized to the canonical low-S
 * form. Mirrors @openconditions/contrib-core's `signSubClaim`.
 *
 * @throws TypeError when the body violates the wire contract or exceeds the
 *   64 KiB canonical size cap.
 */
export async function signSubClaim(body: SubClaimBody, key: DeviceKey): Promise<SignedSubClaim> {
  const bytes = boundedCanonicalBytes(body, "subClaim body");
  validateSubClaimBody(body);
  const raw = await globalThis.crypto.subtle.sign(ECDSA_SIGN_PARAMS, key.privateKey, bytes);
  return {
    ...body,
    alg: "ES256",
    keyId: key.keyId,
    pubJwk: key.publicJwk,
    signature: toBase64Url(normalizeLowS(new Uint8Array(raw) as Uint8Array<ArrayBuffer>)),
  };
}
