import { describe, expect, it } from "vitest";
import { routableFormFactorsFromGroups } from "../rentals-capability.js";

describe("routableFormFactorsFromGroups", () => {
  it("unions routable form factors across groups in a stable order", () => {
    const groups = [
      { formFactors: ["BICYCLE", "CARGO_BICYCLE"] },
      { formFactors: ["SCOOTER_STANDING"] },
      { formFactors: ["BICYCLE"] },
    ];
    expect(routableFormFactorsFromGroups(groups as never)).toEqual([
      "BICYCLE",
      "CARGO_BICYCLE",
      "SCOOTER_STANDING",
    ]);
  });

  it("drops non-routable factors like OTHER", () => {
    const groups = [{ formFactors: ["BICYCLE", "OTHER"] }];
    expect(routableFormFactorsFromGroups(groups as never)).toEqual(["BICYCLE"]);
  });

  it("returns an empty list for no groups or empty factors", () => {
    expect(routableFormFactorsFromGroups(undefined)).toEqual([]);
    expect(routableFormFactorsFromGroups([{ formFactors: [] }] as never)).toEqual([]);
  });
});
