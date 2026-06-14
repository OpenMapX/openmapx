import { describe, expect, it } from "vitest";
import { isOverSpeed, OVER_SPEED_TOLERANCE_KMH } from "../speedAlert";

describe("isOverSpeed", () => {
  it("is false when no limit is known", () => {
    expect(isOverSpeed(40, null)).toBe(false);
    expect(isOverSpeed(40, 0)).toBe(false);
  });

  it("is false within the tolerance", () => {
    // 50 km/h limit, tolerance 7 → flag only above ~57 km/h (15.83 m/s).
    expect(isOverSpeed(15, 50)).toBe(false); // 54 km/h
  });

  it("is true beyond the limit plus tolerance", () => {
    expect(isOverSpeed(18, 50)).toBe(true); // 64.8 km/h > 57
  });

  it("honours a custom tolerance", () => {
    expect(isOverSpeed(15, 50, 0)).toBe(true); // 54 > 50
    expect(isOverSpeed(15, 50, OVER_SPEED_TOLERANCE_KMH)).toBe(false);
  });
});
