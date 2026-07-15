import { toBase64Url } from "./base64url";
import { canonicalClaimBytes } from "./jcs";

/**
 * RFC 7638 section 3.2: the REQUIRED members hashed per key type, in the
 * lexicographic order the thumbprint construction mandates. Every other JWK
 * member (alg, kid, use, key_ops, ext, ...) is ignored by design. Mirrors
 * @openconditions/contrib-core so keyIds agree byte-for-byte.
 */
const REQUIRED_MEMBERS_BY_KTY: Record<string, readonly string[]> = {
  EC: ["crv", "kty", "x", "y"],
  OKP: ["crv", "kty", "x"],
  RSA: ["e", "kty", "n"],
  oct: ["k", "kty"],
};

/**
 * RFC 7638 JWK SHA-256 thumbprint, base64url-encoded. The required members are
 * serialized with JCS (which for a flat object of strings is exactly the RFC
 * 7638 construction: lexicographically sorted keys, no whitespace, UTF-8) and
 * hashed with platform WebCrypto.
 *
 * @throws TypeError when the kty is unknown or a required member is missing or
 *   not a non-empty string.
 */
export async function keyIdFromJwk(jwk: JsonWebKey): Promise<string> {
  if (jwk === null || typeof jwk !== "object" || typeof jwk.kty !== "string") {
    throw new TypeError("keyIdFromJwk: jwk must be an object with a string kty");
  }
  const requiredMembers = REQUIRED_MEMBERS_BY_KTY[jwk.kty];
  if (requiredMembers === undefined) {
    throw new TypeError(`keyIdFromJwk: unsupported kty "${jwk.kty}"`);
  }
  const subset: Record<string, string> = {};
  for (const member of requiredMembers) {
    const value = (jwk as Record<string, unknown>)[member];
    if (typeof value !== "string" || value.length === 0) {
      throw new TypeError(`keyIdFromJwk: required JWK member "${member}" is missing or empty`);
    }
    subset[member] = value;
  }
  const digest = await globalThis.crypto.subtle.digest("SHA-256", canonicalClaimBytes(subset));
  return toBase64Url(new Uint8Array(digest));
}
