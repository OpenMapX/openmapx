/**
 * Verifies a Mangrove review JWT (ES256) against the public key carried in its
 * own header, and cross-checks that the header's `kid` PEM really names that
 * key. Mangrove records are self-authenticating, so a reader can and should
 * check them rather than trusting the aggregator that served them.
 *
 * The exact inverse of `signMangroveReview`: the signed bytes are the ASCII
 * `<header>.<payload>` segments as they appear in the JWT, and the signature is
 * WebCrypto's raw r||s form, not DER.
 */

import { base64UrlToBytes } from "./envelope";
import { publicKeyToPem } from "./keypair";

const ALGO: EcKeyImportParams = { name: "ECDSA", namedCurve: "P-256" };

export type MangroveVerifyFailureReason =
  | "malformed-jwt"
  | "unsupported-alg"
  | "missing-key"
  | "key-import-failed"
  | "kid-mismatch"
  | "signature-mismatch"
  | "bad-signature"
  | "malformed-payload"
  | "crypto-unavailable";

export interface MangroveVerifiedReview {
  ok: true;
  /** Canonical single-line PEM of the key that actually signed the record. */
  kid: string;
  /** Payload decoded from the signed JWT body — the only trustworthy copy. */
  payload: Record<string, unknown>;
}

export interface MangroveVerifyFailure {
  ok: false;
  reason: MangroveVerifyFailureReason;
}

export type MangroveVerifyResult = MangroveVerifiedReview | MangroveVerifyFailure;

export interface MangroveVerifyInput {
  /** The compact JWS as served by the aggregator. */
  jwt: string;
  /** Optional sibling `signature` field; must equal the JWT's third segment. */
  signature?: string;
  /** Optional sibling `kid` field; must name the same key as the header. */
  kid?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function decodeJsonSegment(segment: string): unknown {
  return JSON.parse(new TextDecoder().decode(base64UrlToBytes(segment)));
}

function normalizePem(pem: string): string {
  return pem.replace(/\s+/g, "");
}

export async function verifyMangroveReview(
  input: MangroveVerifyInput,
): Promise<MangroveVerifyResult> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return { ok: false, reason: "crypto-unavailable" };

  if (!input || typeof input.jwt !== "string") {
    return { ok: false, reason: "malformed-jwt" };
  }
  const parts = input.jwt.split(".");
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
    return { ok: false, reason: "malformed-jwt" };
  }

  let header: Record<string, unknown>;
  try {
    const decoded = decodeJsonSegment(parts[0]);
    if (!isRecord(decoded)) return { ok: false, reason: "malformed-jwt" };
    header = decoded;
  } catch {
    return { ok: false, reason: "malformed-jwt" };
  }

  if (header.alg !== "ES256") {
    return { ok: false, reason: "unsupported-alg" };
  }
  if (input.signature !== undefined && input.signature !== parts[2]) {
    return { ok: false, reason: "signature-mismatch" };
  }

  let key: CryptoKey;
  if (header.jwk !== undefined) {
    let jwk: unknown = header.jwk;
    if (typeof jwk === "string") {
      try {
        jwk = JSON.parse(jwk);
      } catch {
        return { ok: false, reason: "malformed-jwt" };
      }
    }
    if (!isRecord(jwk)) return { ok: false, reason: "missing-key" };

    const { kty, crv, x, y } = jwk;
    if (kty !== "EC" || crv !== "P-256" || typeof x !== "string" || typeof y !== "string") {
      return { ok: false, reason: "missing-key" };
    }

    try {
      key = await subtle.importKey("jwk", { kty, crv, x, y }, ALGO, true, ["verify"]);
    } catch {
      return { ok: false, reason: "key-import-failed" };
    }
  } else if (typeof header.kid === "string" && header.kid.includes("BEGIN PUBLIC KEY")) {
    const spkiBase64 = header.kid
      .replace("-----BEGIN PUBLIC KEY-----", "")
      .replace("-----END PUBLIC KEY-----", "")
      .replace(/\s+/g, "");
    try {
      key = await subtle.importKey("spki", base64UrlToBytes(spkiBase64), ALGO, true, ["verify"]);
    } catch {
      return { ok: false, reason: "key-import-failed" };
    }
  } else {
    return { ok: false, reason: "missing-key" };
  }

  let derivedPem: string;
  try {
    derivedPem = await publicKeyToPem(key);
  } catch {
    return { ok: false, reason: "key-import-failed" };
  }
  const normalizedDerivedPem = normalizePem(derivedPem);
  if (
    (header.kid !== undefined &&
      (typeof header.kid !== "string" || normalizePem(header.kid) !== normalizedDerivedPem)) ||
    (input.kid !== undefined &&
      (typeof input.kid !== "string" || normalizePem(input.kid) !== normalizedDerivedPem))
  ) {
    return { ok: false, reason: "kid-mismatch" };
  }

  let signatureValid: boolean;
  try {
    signatureValid = await subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      base64UrlToBytes(parts[2]),
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
    );
  } catch {
    return { ok: false, reason: "bad-signature" };
  }
  if (!signatureValid) return { ok: false, reason: "bad-signature" };

  let payload: Record<string, unknown>;
  try {
    const decoded = decodeJsonSegment(parts[1]);
    if (!isRecord(decoded)) return { ok: false, reason: "malformed-payload" };
    payload = decoded;
  } catch {
    return { ok: false, reason: "malformed-payload" };
  }
  if (typeof payload.sub !== "string" || typeof payload.iat !== "number") {
    return { ok: false, reason: "malformed-payload" };
  }

  return { ok: true, kid: derivedPem, payload };
}
