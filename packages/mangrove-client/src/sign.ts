/**
 * Signs a Mangrove review JWT (ES256) in the browser.
 *
 * We build the JWT manually rather than using jose's `SignJWT` because
 * Mangrove's protected header carries BOTH a `kid` (single-line PEM) AND a
 * `jwk` (stringified public JWK) — and the `jwk` entry is a string literal,
 * not the JSON object that JOSE's standard schema expects. All cryptography
 * is WebCrypto-backed; we only use plain base64url encoding here.
 */

import type { MangroveKeypair } from "./keypair";
import { publicKeyToPem } from "./keypair";

export interface MangroveReviewPayload {
  sub: string;
  rating?: number;
  opinion?: string;
  images?: { src: string; label?: string }[];
  action?: "edit" | "delete" | "report_abuse" | "equivalence";
  metadata?: {
    client_id?: string;
    nickname?: string;
    preferred_username?: string;
    /**
     * Free-form string; the official Mangrove UI sends scheme-specific values.
     * For `geo:` subjects (places) it uses: "business" | "family" | "couple/date"
     * | "sightseeing" | "friends" — matched by {@link EXPERIENCE_CONTEXT_GEO}.
     */
    experience_context?: string;
    is_personal_experience?: boolean;
    is_affiliated?: boolean;
    is_generated?: boolean;
    data_source?: string;
    original_url?: string;
    osm_id?: string;
    reviewer_index?: number;
    license?: "CC-BY-4.0" | "CC-BY-SA-4.0";
  };
}

/**
 * Signing only ever runs in the browser (requires WebCrypto + the user's
 * private key), so `window.location.origin` is reliably defined here. The
 * runtime origin means reviews sent from dev/staging/custom hosts are filed
 * under those origins in the Mangrove aggregate stats instead of polluting
 * the production domain's count.
 */
function defaultClientId(): string {
  return typeof window !== "undefined" && window.location?.origin
    ? window.location.origin
    : "unknown";
}

export async function signMangroveReview(
  payload: MangroveReviewPayload,
  kp: MangroveKeypair,
): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("WebCrypto unavailable");

  const pem = await publicKeyToPem(kp.publicKey);
  const publicJwk = await subtle.exportKey("jwk", kp.publicKey);
  const publicHeader = { kty: publicJwk.kty, crv: publicJwk.crv, x: publicJwk.x, y: publicJwk.y };

  const header = {
    alg: "ES256",
    typ: "JWT",
    kid: pem,
    jwk: JSON.stringify(publicHeader),
  };

  const body = { ...normalizeMangrovePayload(payload), iat: Math.floor(Date.now() / 1000) };
  const signingInput = `${base64urlEncode(JSON.stringify(header))}.${base64urlEncode(JSON.stringify(body))}`;

  const sigBuf = await subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    kp.privateKey,
    new TextEncoder().encode(signingInput),
  );
  const signature = base64urlEncodeBytes(new Uint8Array(sigBuf));

  return `${signingInput}.${signature}`;
}

export function normalizeMangrovePayload(p: MangroveReviewPayload): MangroveReviewPayload {
  const out: Record<string, unknown> = {
    sub: p.sub,
  };
  if (p.rating !== undefined) out.rating = Math.round(p.rating);
  if (p.opinion) out.opinion = p.opinion.slice(0, 1000);
  if (p.images?.length) out.images = p.images.slice(0, 5);
  if (p.action) out.action = p.action;
  const metadata: Record<string, unknown> = {};
  if (p.metadata) {
    for (const [k, v] of Object.entries(p.metadata)) {
      if (v === undefined || v === null || v === false) continue;
      metadata[k] = v;
    }
  }
  if (!metadata.client_id) metadata.client_id = defaultClientId();
  out.metadata = metadata;
  return out as unknown as MangroveReviewPayload;
}

function base64urlEncode(input: string): string {
  return base64urlEncodeBytes(new TextEncoder().encode(input));
}

function base64urlEncodeBytes(bytes: Uint8Array): string {
  const b64 =
    typeof Buffer !== "undefined" ? Buffer.from(bytes).toString("base64") : btoaFromBytes(bytes);
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function btoaFromBytes(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/** Short fingerprint of a PEM key — used as a stable display id. */
export function fingerprintPem(pem: string): string {
  const body = pem
    .replace(/-----BEGIN PUBLIC KEY-----/, "")
    .replace(/-----END PUBLIC KEY-----/, "");
  return body.slice(0, 8);
}

/** Compare only verified JWT content; issue time belongs to the signer. */
export function matchesMangrovePayload(
  actual: Record<string, unknown>,
  expected: MangroveReviewPayload,
): boolean {
  if (typeof actual.iat !== "number" || !Number.isSafeInteger(actual.iat) || actual.iat < 0)
    return false;
  const { iat: _iat, ...content } = actual;
  if (typeof content.sub !== "string") return false;
  if (content.sub !== expected.sub) {
    const left = geoSubject(content.sub);
    const right = geoSubject(expected.sub);
    if (!left || !right || stable(left) !== stable(right)) return false;
    content.sub = expected.sub;
  }
  return stable(content) === stable(expected);
}
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
function geoSubject(value: string): unknown {
  const match = /^geo:([^,?]+),([^?]+)\?(.+)$/.exec(value);
  if (!match) return null;
  const params = new URLSearchParams(match[3]);
  if (
    [...params.keys()].some((key) => key !== "q" && key !== "u") ||
    params.getAll("q").length !== 1 ||
    params.getAll("u").length !== 1
  )
    return null;
  const lat = Number(match[1]),
    lng = Number(match[2]),
    uncertainty = Number(params.get("u"));
  if (![lat, lng, uncertainty].every(Number.isFinite)) return null;
  return { lat, lng, uncertainty, name: params.get("q") };
}
