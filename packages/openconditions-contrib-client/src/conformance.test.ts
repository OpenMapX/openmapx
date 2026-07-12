import { describe, expect, it } from "vitest";
import { fromBase64Url } from "./base64url.js";
import { generateDeviceKey, loadOrCreateDeviceKey } from "./device.js";
import { canonicalClaimBytes } from "./jcs.js";
import { P256_HALF_ORDER, signatureS } from "./lowS.js";
import { signReport, signSubClaim } from "./sign.js";
import { keyIdFromJwk } from "./thumbprint.js";
import type { ReportClaim } from "./types.js";

// Cross-repo parity anchors. These EXACT values are also asserted, byte-for-byte,
// by @openconditions/contrib-core in
// packages/contrib-core/src/__tests__/cross-repo-conformance.test.ts. If either
// side drifts (canonicalization or thumbprint), one of the two suites fails.

// A FIXED P-256 public JWK (thumbprint members only).
const FIXED_PUBLIC_JWK: JsonWebKey = {
  crv: "P-256",
  kty: "EC",
  x: "BFxqp9dVKtDIkpHcFM5eHXlrV0Q1UJUGGOdUvsXQYLQ",
  y: "LB2daYNRhrfJ41l6-JVcUBiXFH5V4n9yU-LzHvHMkns",
};

// Pinned RFC 7638 base64url thumbprint of FIXED_PUBLIC_JWK.
const PINNED_KEY_ID = "GlQczzclqGJy6D0X9dNq8pSYKRfkCqszpEp5g3ZGlwY";

// A FIXED ReportClaim exercising every optional field, non-ASCII text, and a
// nested attributes object — so the canonical byte pin catches key-ordering and
// UTF-8 divergence.
const FIXED_CLAIM: ReportClaim = {
  domain: "roads",
  type: "hazard_object",
  geometry: { type: "Point", coordinates: [7.0982, 50.7374] },
  fuzziness: "exact",
  subject: [{ type: "osm", id: "way/23368509" }],
  severityLevel: 3,
  attributes: { note: "Fahrbahn verschmutzt — Öl", laneCount: 2 },
  reportedAt: "2026-07-11T12:34:56.789Z",
  nonce: "conformance-nonce-0001",
};

// Pinned hex of canonicalClaimBytes(FIXED_CLAIM).
const PINNED_CLAIM_HEX =
  "7b2261747472696275746573223a7b226c616e65436f756e74223a322c226e6f7465223a22466168726261686e207665727363686d75747a7420e2809420c3966c227d2c22646f6d61696e223a22726f616473222c2266757a7a696e657373223a226578616374222c2267656f6d65747279223a7b22636f6f7264696e61746573223a5b372e303938322c35302e373337345d2c2274797065223a22506f696e74227d2c226e6f6e6365223a22636f6e666f726d616e63652d6e6f6e63652d30303031222c227265706f727465644174223a22323032362d30372d31315431323a33343a35362e3738395a222c2273657665726974794c6576656c223a332c227375626a656374223a5b7b226964223a227761792f3233333638353039222c2274797065223a226f736d227d5d2c2274797065223a2268617a6172645f6f626a656374227d";

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

describe("cross-repo conformance", () => {
  it("keyIdFromJwk matches the pinned RFC 7638 thumbprint", async () => {
    expect(await keyIdFromJwk(FIXED_PUBLIC_JWK)).toBe(PINNED_KEY_ID);
  });

  it("canonicalClaimBytes matches the pinned RFC 8785 hex", () => {
    expect(toHex(canonicalClaimBytes(FIXED_CLAIM))).toBe(PINNED_CLAIM_HEX);
  });
});

describe("round-trip signing", () => {
  it("signReport produces a low-S signature that verifies against the recomputed claim bytes", async () => {
    const key = await generateDeviceKey();
    const signed = await signReport(FIXED_CLAIM, key);

    expect(signed.alg).toBe("ES256");
    expect(signed.keyId).toBe(key.keyId);
    expect(signed.pubJwk).toEqual(key.publicJwk);

    const rawSig = fromBase64Url(signed.signature);
    expect(rawSig.length).toBe(64);
    // low-S: s must be in the lower half of the group order.
    expect(signatureS(rawSig) <= P256_HALF_ORDER).toBe(true);

    const publicKey = await globalThis.crypto.subtle.importKey(
      "jwk",
      signed.pubJwk as JsonWebKey,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    const ok = await globalThis.crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      publicKey,
      rawSig,
      canonicalClaimBytes(signed.claim),
    );
    expect(ok).toBe(true);
  });

  it("signSubClaim signs the body without the envelope fields and stays low-S", async () => {
    const key = await generateDeviceKey();
    const body = {
      subject: `urn:openconditions:report:${"a".repeat(43)}`,
      claimType: "confirm" as const,
      reportedAt: "2026-07-11T12:35:00Z",
      nonce: "subclaim-nonce-000001",
    };
    const signed = await signSubClaim(body, key);

    const rawSig = fromBase64Url(signed.signature);
    expect(signatureS(rawSig) <= P256_HALF_ORDER).toBe(true);

    // The verifier reconstructs the body by dropping alg/keyId/pubJwk/signature.
    const reconstructed = {
      subject: signed.subject,
      claimType: signed.claimType,
      reportedAt: signed.reportedAt,
      nonce: signed.nonce,
    };
    const publicKey = await globalThis.crypto.subtle.importKey(
      "jwk",
      signed.pubJwk as JsonWebKey,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    const ok = await globalThis.crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      publicKey,
      rawSig,
      canonicalClaimBytes(reconstructed),
    );
    expect(ok).toBe(true);
  });
});

describe("device key persistence", () => {
  it("loadOrCreateDeviceKey mints then reloads a stable keyId", async () => {
    let saved: { privateJwk: JsonWebKey } | null = null;
    const store = {
      get: () => saved,
      set: (value: { privateJwk: JsonWebKey }) => {
        saved = value;
      },
    };

    const first = await loadOrCreateDeviceKey(store);
    expect(saved).not.toBeNull();
    const second = await loadOrCreateDeviceKey(store);
    expect(second.keyId).toBe(first.keyId);
    expect(second.publicJwk).toEqual(first.publicJwk);
  });
});
