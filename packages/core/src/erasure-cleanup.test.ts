import { describe, expect, it } from "vitest";
import {
  erasureVerificationIdentifiers,
  isTerminalPrivacyRequestState,
  TERMINAL_PRIVACY_REQUEST_STATES,
} from "./erasure-cleanup";

describe("erasure cleanup policy", () => {
  it("classifies only completed privacy request states as terminal", () => {
    expect(TERMINAL_PRIVACY_REQUEST_STATES).toEqual([
      "delivered",
      "artifact_expired",
      "withdrawn",
      "refused",
      "closed",
    ]);
    expect(isTerminalPrivacyRequestState("closed")).toBe(true);
    expect(isTerminalPrivacyRequestState("ready")).toBe(false);
    expect(isTerminalPrivacyRequestState("operator_review")).toBe(false);
  });

  it("returns only the exact Better Auth verification identities for an erased user", () => {
    expect(
      erasureVerificationIdentifiers({
        id: "user-1",
        email: "Person@Example.test",
      }),
    ).toEqual(["Person@Example.test", "change-email:user-1:Person@Example.test"]);
  });
});
