import { describe, expect, it } from "vitest";
import {
  signTransitPageToken,
  transitRequestFingerprint,
  verifyTransitPageToken,
} from "../page-token.js";

const SECRET = "test-secret-that-is-long-enough-for-hmac";

describe("signed transit paging tokens", () => {
  const query = { from_lat: "52.5", to_lat: "48.1", transfer_buffer: "relaxed" };
  const fingerprint = transitRequestFingerprint(query);

  it("round-trips an opaque cursor bound to request, instance, epoch, and direction", () => {
    const token = signTransitPageToken(
      {
        cursor: "upstream-secret-cursor",
        source: "transit-motis-local",
        instance: "ms",
        datasetEpoch: "epoch-42",
        fingerprint,
        direction: "next",
      },
      SECRET,
      100,
    );
    expect(token).not.toContain("upstream-secret-cursor");
    expect(verifyTransitPageToken(token, SECRET, fingerprint, 101)).toMatchObject({
      cursor: "upstream-secret-cursor",
      datasetEpoch: "epoch-42",
      direction: "next",
    });
  });

  it("rejects tampering, changed options, and expiry", () => {
    const token = signTransitPageToken(
      {
        cursor: "cursor",
        source: "local",
        instance: "ms",
        datasetEpoch: "epoch",
        fingerprint,
        direction: "previous",
      },
      SECRET,
      100,
    );
    expect(() => verifyTransitPageToken(`${token}x`, SECRET, fingerprint, 101)).toThrow();
    expect(() => verifyTransitPageToken(token, SECRET, "different", 101)).toThrow();
    expect(() => verifyTransitPageToken(token, SECRET, fingerprint, 100 + 901)).toThrow();
  });

  it("excludes only the page token from a request fingerprint", () => {
    expect(transitRequestFingerprint({ ...query, page_token: "one" })).toBe(
      transitRequestFingerprint({ ...query, page_token: "two" }),
    );
    expect(transitRequestFingerprint({ ...query, max_transfers: "2" })).not.toBe(fingerprint);
  });
});
