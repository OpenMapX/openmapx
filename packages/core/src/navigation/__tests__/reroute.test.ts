import { describe, expect, it } from "vitest";
import { shouldReroute } from "../reroute";

const opts = { thresholdMeters: 40, consecutiveFixes: 3, debounceMs: 10_000 };

describe("shouldReroute", () => {
  it("returns false until enough consecutive off-route fixes", () => {
    expect(shouldReroute([50, 50], null, 0, opts)).toBe(false);
  });

  it("returns true after N consecutive fixes over threshold", () => {
    expect(shouldReroute([50, 60, 55], null, 0, opts)).toBe(true);
  });

  it("returns false when any of the last N is under threshold", () => {
    expect(shouldReroute([50, 10, 55], null, 0, opts)).toBe(false);
  });

  it("respects the debounce window", () => {
    expect(shouldReroute([50, 60, 55], 1_000, 5_000, opts)).toBe(false); // 4s < 10s
    expect(shouldReroute([50, 60, 55], 1_000, 12_000, opts)).toBe(true); // 11s > 10s
  });
});
