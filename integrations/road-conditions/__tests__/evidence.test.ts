import { describe, expect, it } from "vitest";
import { isUnconfirmedCrowd } from "../evidence";

describe("isUnconfirmedCrowd", () => {
  it("is true for a self-reported crowd situation", () => {
    expect(isUnconfirmedCrowd({ origin: "crowd", evidence: { state: "self_reported" } })).toBe(
      true,
    );
  });

  it("is true for a crowd situation with no evidence", () => {
    expect(isUnconfirmedCrowd({ origin: "crowd" })).toBe(true);
  });

  it("is false once a crowd situation is externally resolved", () => {
    expect(
      isUnconfirmedCrowd({ origin: "crowd", evidence: { state: "externally_resolved" } }),
    ).toBe(false);
  });

  it("is false for any other origin", () => {
    for (const origin of ["feed", "federation", "derived"] as const) {
      expect(isUnconfirmedCrowd({ origin, evidence: { state: "self_reported" } })).toBe(false);
    }
  });
});
