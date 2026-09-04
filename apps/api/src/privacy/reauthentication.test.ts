import { describe, expect, it } from "vitest";
import {
  createReauthenticationNonce,
  digestReauthenticationNonce,
  isAssuranceSufficient,
  REAUTH_COOKIE_NAME,
} from "./reauthentication.js";

describe("privacy export reauthentication", () => {
  it("creates a 32-byte nonce and a non-reversible digest", () => {
    const nonce = createReauthenticationNonce();
    expect(nonce.byteLength).toBe(32);
    expect(digestReauthenticationNonce(nonce)).toHaveLength(64);
    expect(REAUTH_COOKIE_NAME).toMatch(/^__Host-/);
  });

  it.each([
    ["password", false, true],
    ["password", true, false],
    ["password_totp", true, true],
    ["password_recovery", true, true],
    ["passkey", false, true],
    ["federated", false, true],
    ["passkey", true, false],
    ["federated", true, false],
  ])("applies MFA assurance policy (%s, configured=%s)", (method, mfa, expected) => {
    expect(isAssuranceSufficient(method as never, mfa as boolean)).toBe(expected);
  });
});
