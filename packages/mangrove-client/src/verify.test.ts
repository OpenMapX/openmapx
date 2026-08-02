import { describe, expect, it } from "vitest";
import { base64UrlToBytes, bytesToBase64Url } from "./envelope";
import { generateKeypair, publicKeyToPem } from "./keypair";
import { signMangroveReview } from "./sign";
import { verifyMangroveReview } from "./verify";

function encodeJson(value: unknown): string {
  return bytesToBase64Url(new TextEncoder().encode(JSON.stringify(value)));
}

function decodeJson(segment: string): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(base64UrlToBytes(segment))) as Record<string, unknown>;
}

async function resign(
  headerSegment: string,
  payloadSegment: string,
  privateKey: CryptoKey,
): Promise<string> {
  const signingInput = `${headerSegment}.${payloadSegment}`;
  const signature = await globalThis.crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${bytesToBase64Url(new Uint8Array(signature))}`;
}

describe("verifyMangroveReview", () => {
  it("verifies a valid Mangrove review record", async () => {
    const kp = await generateKeypair();
    const payload = { sub: "geo:50.775,6.087?q=X&u=30", rating: 80 };
    const jwt = await signMangroveReview(payload, kp);
    const parts = jwt.split(".");
    const pem = await publicKeyToPem(kp.publicKey);

    const result = await verifyMangroveReview({ jwt, signature: parts[2], kid: pem });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.payload.rating).toBe(80);
    expect(result.payload.sub).toBe(payload.sub);
    expect(result.kid).toBe(pem);
  });

  it("rejects a tampered payload", async () => {
    const kp = await generateKeypair();
    const jwt = await signMangroveReview({ sub: "geo:50.775,6.087?q=X&u=30", rating: 80 }, kp);
    const parts = jwt.split(".");
    const payload = decodeJson(parts[1]);
    payload.rating = 20;
    const tampered = `${parts[0]}.${encodeJson(payload)}.${parts[2]}`;

    await expect(verifyMangroveReview({ jwt: tampered })).resolves.toEqual({
      ok: false,
      reason: "bad-signature",
    });
  });

  it("rejects a kid that names a different key", async () => {
    const kpA = await generateKeypair();
    const kpB = await generateKeypair();
    const jwt = await signMangroveReview({ sub: "geo:50.775,6.087?q=X&u=30", rating: 80 }, kpA);
    const parts = jwt.split(".");
    const header = decodeJson(parts[0]);
    header.kid = await publicKeyToPem(kpB.publicKey);
    const forged = await resign(encodeJson(header), parts[1], kpA.privateKey);

    await expect(verifyMangroveReview({ jwt: forged })).resolves.toEqual({
      ok: false,
      reason: "kid-mismatch",
    });
  });

  it("rejects a mismatched sibling signature", async () => {
    const kp = await generateKeypair();
    const jwt = await signMangroveReview({ sub: "geo:50.775,6.087?q=X&u=30", rating: 80 }, kp);

    await expect(
      verifyMangroveReview({ jwt, signature: "not-the-real-signature" }),
    ).resolves.toEqual({
      ok: false,
      reason: "signature-mismatch",
    });
  });

  it("rejects a non-ES256 header", async () => {
    const kp = await generateKeypair();
    const jwt = await signMangroveReview({ sub: "geo:50.775,6.087?q=X&u=30", rating: 80 }, kp);
    const parts = jwt.split(".");
    const header = decodeJson(parts[0]);
    header.alg = "none";
    const unsupported = `${encodeJson(header)}.${parts[1]}.${parts[2]}`;

    await expect(verifyMangroveReview({ jwt: unsupported })).resolves.toEqual({
      ok: false,
      reason: "unsupported-alg",
    });
  });

  it("verifies a record without a jwk header through its kid PEM", async () => {
    const kp = await generateKeypair();
    const jwt = await signMangroveReview({ sub: "geo:50.775,6.087?q=X&u=30", rating: 80 }, kp);
    const parts = jwt.split(".");
    const header = decodeJson(parts[0]);
    delete header.jwk;
    const rebuilt = await resign(encodeJson(header), parts[1], kp.privateKey);
    const rebuiltParts = rebuilt.split(".");

    const result = await verifyMangroveReview({
      jwt: rebuilt,
      signature: rebuiltParts[2],
      kid: await publicKeyToPem(kp.publicKey),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.payload.rating).toBe(80);
  });
});
