import { afterEach, describe, expect, it, vi } from "vitest";
import { decryptHandoffToken, encryptHandoffToken } from "./mobileAuthHandoffCrypto";

const SECRET = "handoff-test-auth-secret-with-more-than-thirty-two-characters";

afterEach(() => vi.unstubAllEnvs());

describe("mobile auth handoff token encryption", () => {
  it("round-trips without storing the token in its authenticated envelope", () => {
    vi.stubEnv("BETTER_AUTH_SECRET", SECRET);

    const encrypted = encryptHandoffToken("ott-redeemable-value", "handoff-row-1");

    expect(JSON.stringify(encrypted)).not.toContain("ott-redeemable-value");
    expect(decryptHandoffToken(encrypted, "handoff-row-1")).toBe("ott-redeemable-value");
  });

  it("uses a fresh nonce when the same token is encrypted twice", () => {
    vi.stubEnv("BETTER_AUTH_SECRET", SECRET);

    const first = encryptHandoffToken("same-token", "handoff-row-1");
    const second = encryptHandoffToken("same-token", "handoff-row-1");

    expect(second).not.toEqual(first);
  });

  it("rejects ciphertext copied to a different handoff row", () => {
    vi.stubEnv("BETTER_AUTH_SECRET", SECRET);
    const encrypted = encryptHandoffToken("same-token", "handoff-row-1");

    expect(() => decryptHandoffToken(encrypted, "handoff-row-2")).toThrow();
  });

  it("rejects a modified authentication tag", () => {
    vi.stubEnv("BETTER_AUTH_SECRET", SECRET);
    const encrypted = encryptHandoffToken("same-token", "handoff-row-1");
    const modifiedTag = Buffer.from(encrypted.tag, "base64");
    modifiedTag[0] ^= 1;

    expect(() =>
      decryptHandoffToken({ ...encrypted, tag: modifiedTag.toString("base64") }, "handoff-row-1"),
    ).toThrow();
  });

  it("fails closed when the required auth secret is unavailable", () => {
    vi.stubEnv("BETTER_AUTH_SECRET", undefined);

    expect(() => encryptHandoffToken("same-token", "handoff-row-1")).toThrow(/BETTER_AUTH_SECRET/);
  });
});
