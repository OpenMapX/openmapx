import { describe, expect, it } from "vitest";
import { signRefreshHandle, verifyRefreshHandle } from "../refresh-token.js";

describe("itinerary refresh handles", () => {
  const secret = "test-secret-long-enough";

  it("round-trips an opaque server-side state id", () => {
    const token = signRefreshHandle("state-id", secret, 200);
    expect(token).not.toContain("state-id");
    expect(verifyRefreshHandle(token, secret, 100)).toMatchObject({ id: "state-id" });
  });

  it("rejects tampering and expiry", () => {
    const token = signRefreshHandle("state-id", secret, 200);
    expect(() => verifyRefreshHandle(`${token}x`, secret, 100)).toThrow();
    expect(() => verifyRefreshHandle(token, secret, 201)).toThrow();
  });
});
