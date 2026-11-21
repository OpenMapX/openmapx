import { describe, expect, it } from "vitest";
import { detectTier, TIER_BUDGETS } from "../web/tiers";

describe("device tiers", () => {
  it.each([
    [{ pointerCoarse: true, deviceMemory: 8, hardwareConcurrency: 8 }, "light"],
    [{ pointerCoarse: false, deviceMemory: 4, hardwareConcurrency: 8 }, "light"],
    [{ pointerCoarse: false, deviceMemory: 8, hardwareConcurrency: 4 }, "light"],
    [{ pointerCoarse: false, deviceMemory: 8, hardwareConcurrency: 8 }, "full"],
    [{ pointerCoarse: false }, "full"],
    [{ pointerCoarse: false, hardwareConcurrency: 6 }, "full"],
  ] as const)("classifies %j as %s", (nav, tier) => {
    expect(detectTier(nav)).toBe(tier);
  });

  it("budgets trees and furniture per tier", () => {
    expect(TIER_BUDGETS).toEqual({
      full: { trees: 6000, furniture: 1500 },
      light: { trees: 2000, furniture: 500 },
    });
  });
});
