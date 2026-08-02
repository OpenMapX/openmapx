import type { MangroveKeypair, MangroveReviewPayload } from "@openmapx/mangrove-client";
import { generateKeypair, publicKeyToPem, signMangroveReview } from "@openmapx/mangrove-client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mangroveGetReviews } from "../client.js";
import {
  getMangroveVerificationStats,
  mangroveProvider,
  resetMangroveVerificationStats,
} from "../provider.js";
import type { MangroveWireReview } from "../types.js";

vi.mock("../client.js", () => ({
  mangroveGetReviews: vi.fn(),
  mangroveSubmit: vi.fn(),
  mangroveUploadImage: vi.fn(),
}));

const SUBJECT = {
  lat: 50.7750682,
  lng: 6.0877905,
  name: "Frittenwerk",
  osmId: "node/4506022549",
};
const SUBJECT_URI = "geo:50.7750682,6.0877905?q=Frittenwerk&u=50";
const FAKE_KID = "-----BEGIN PUBLIC KEY-----fake-----END PUBLIC KEY-----";

async function signedWire(
  kp: MangroveKeypair,
  payload: MangroveReviewPayload,
  overrides: Partial<MangroveWireReview> = {},
): Promise<MangroveWireReview> {
  const jwt = await signMangroveReview(payload, kp);
  const [, body, signature] = jwt.split(".");
  if (!body || !signature) throw new Error("signMangroveReview returned an invalid JWT");
  return {
    jwt,
    signature,
    kid: await publicKeyToPem(kp.publicKey),
    payload: JSON.parse(Buffer.from(body, "base64url").toString("utf8")),
    ...overrides,
  } as MangroveWireReview;
}

function invalidWire(overrides: Partial<MangroveWireReview> = {}): MangroveWireReview {
  return {
    signature: "invalid-signature",
    jwt: "not.a.jwt",
    kid: FAKE_KID,
    payload: {
      sub: SUBJECT_URI,
      iat: 1_775_485_449,
      rating: 25,
      opinion: "Fries, fries, fries.",
      metadata: { osm_id: SUBJECT.osmId },
    },
    ...overrides,
  };
}

const mockedGetReviews = vi.mocked(mangroveGetReviews);

describe("Mangrove review verification rollout", () => {
  beforeEach(() => {
    mockedGetReviews.mockReset();
    resetMangroveVerificationStats();
  });

  it("drops unverifiable records while counting the failure", async () => {
    mockedGetReviews.mockResolvedValue({ reviews: [invalidWire()] });

    const reviews = await mangroveProvider.getReviews(SUBJECT);
    const stats = getMangroveVerificationStats();

    expect(reviews).toEqual([]);
    expect(stats).toMatchObject({ checked: 1, verified: 0, failed: 1 });
    expect(stats.reasons["malformed-jwt"]).toBe(1);
  });

  it("uses the signed payload instead of the sibling wire payload", async () => {
    const kp = await generateKeypair();
    const wire = await signedWire(
      kp,
      {
        sub: SUBJECT_URI,
        rating: 80,
        metadata: { osm_id: SUBJECT.osmId },
      },
      { payload: { sub: SUBJECT_URI, iat: 1_775_485_449, rating: 20 } },
    );
    mockedGetReviews.mockResolvedValue({ reviews: [wire] });

    const reviews = await mangroveProvider.getReviews(SUBJECT);

    expect(reviews).toHaveLength(1);
    expect(reviews[0]?.rating).toBe(80);
    expect(getMangroveVerificationStats()).toMatchObject({ checked: 1, verified: 1, failed: 0 });
  });

  it("blocks a forged delete", async () => {
    const victimKeypair = await generateKeypair();
    const attackerKeypair = await generateKeypair();
    const victim = await signedWire(victimKeypair, {
      sub: SUBJECT_URI,
      rating: 80,
      metadata: { osm_id: SUBJECT.osmId },
    });
    const forgedDelete = await signedWire(
      attackerKeypair,
      {
        sub: `urn:maresi:${victim.signature}`,
        action: "delete",
        metadata: { osm_id: SUBJECT.osmId },
      },
      { kid: victim.kid, original_sub: SUBJECT_URI },
    );
    mockedGetReviews.mockResolvedValue({ reviews: [forgedDelete, victim] });

    const reviews = await mangroveProvider.getReviews(SUBJECT);
    const stats = getMangroveVerificationStats();

    expect(reviews).toHaveLength(1);
    expect(reviews[0]?.id).toBe(victim.signature);
    expect(stats.failed).toBe(1);
  });
});
