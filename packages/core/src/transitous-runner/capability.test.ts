import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CAPABILITY_TTL_MS,
  mintTransitousCapability,
  verifyTransitousCapability,
} from "./capability";
import { transitousRunnerRequestSchema } from "./contract";

const KEY = Buffer.alloc(32, 7);
const NOW = 1_760_000_000_000;
const RUN = { script: "garbage-collect" } as const;

describe("Transitous runner capabilities", () => {
  it("mints a token the request schema accepts", () => {
    const capability = mintTransitousCapability(KEY, { now: NOW, run: RUN });
    expect(
      transitousRunnerRequestSchema.safeParse({
        version: 1,
        capability,
        run: { script: "garbage-collect" },
      }).success,
    ).toBe(true);
  });

  it("verifies its own token and rejects one signed with another key", () => {
    const capability = mintTransitousCapability(KEY, { now: NOW, run: RUN });
    expect(verifyTransitousCapability(KEY, capability, RUN, NOW)).toEqual({
      ok: true,
      nonce: expect.any(String),
    });
    expect(verifyTransitousCapability(randomBytes(32), capability, RUN, NOW)).toEqual({
      ok: false,
      reason: "signature",
    });
  });

  it("rejects a token whose payload was altered after signing", () => {
    const capability = mintTransitousCapability(KEY, { now: NOW, run: RUN });
    const [prefix, issuedAt, nonce, mac] = capability.split("_");
    // Still a well-formed nonce, so this must fail on the signature rather than
    // on the shape check.
    const flipped = nonce.endsWith("0") ? "1" : "0";
    const forged = [prefix, issuedAt, `${nonce.slice(0, -1)}${flipped}`, mac].join("_");
    expect(verifyTransitousCapability(KEY, forged, RUN, NOW)).toEqual({
      ok: false,
      reason: "signature",
    });
  });

  it("expires a token once its short lifetime has passed", () => {
    const capability = mintTransitousCapability(KEY, { now: NOW, run: RUN });
    expect(verifyTransitousCapability(KEY, capability, RUN, NOW + CAPABILITY_TTL_MS - 1).ok).toBe(
      true,
    );
    expect(verifyTransitousCapability(KEY, capability, RUN, NOW + CAPABILITY_TTL_MS + 1)).toEqual({
      ok: false,
      reason: "expired",
    });
    // A token minted in the future is as suspect as an expired one: it would
    // otherwise extend the replay window arbitrarily.
    expect(verifyTransitousCapability(KEY, capability, RUN, NOW - 120_000)).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  it("mints a distinct nonce per call", () => {
    const nonces = new Set(
      Array.from({ length: 64 }, () => {
        const verified = verifyTransitousCapability(
          KEY,
          mintTransitousCapability(KEY, { now: NOW, run: RUN }),
          RUN,
          NOW,
        );
        return verified.ok ? verified.nonce : "";
      }),
    );
    expect(nonces.size).toBe(64);
  });

  it("rejects malformed input without throwing", () => {
    for (const candidate of ["", "trc1_", "nope", "trc1_a_b", `trc1_${"a".repeat(200)}`]) {
      expect(verifyTransitousCapability(KEY, candidate, RUN, NOW).ok).toBe(false);
    }
  });

  it("binds a capability to the exact run it authorizes", () => {
    const capability = mintTransitousCapability(KEY, { now: NOW, run: RUN });
    expect(
      verifyTransitousCapability(KEY, capability, { script: "generate-attribution" }, NOW),
    ).toEqual({ ok: false, reason: "signature" });
  });
});
