import { describe, expect, it } from "vitest";
import { erasureVerificationIdentifiers } from "./erasure-cleanup";

describe("erasure cleanup policy", () => {
  it("returns only the exact Better Auth verification identities for an erased user", () => {
    expect(
      erasureVerificationIdentifiers({
        id: "user-1",
        email: "Person@Example.test",
      }),
    ).toEqual(["Person@Example.test", "change-email:user-1:Person@Example.test"]);
  });
});
