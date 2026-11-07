import { describe, expect, it } from "vitest";
import { bandForDelayRatio } from "./trafficSeverity";

describe("bandForDelayRatio", () => {
  it("returns null below the 10% display threshold", () => {
    expect(bandForDelayRatio(0)).toBeNull();
    expect(bandForDelayRatio(0.099)).toBeNull();
  });

  it("maps each band at its lower boundary", () => {
    expect(bandForDelayRatio(0.1)).toBe("light");
    expect(bandForDelayRatio(0.25)).toBe("moderate");
    expect(bandForDelayRatio(0.5)).toBe("heavy");
    expect(bandForDelayRatio(1)).toBe("severe");
  });

  it("maps each band just under its upper boundary", () => {
    expect(bandForDelayRatio(0.249)).toBe("light");
    expect(bandForDelayRatio(0.499)).toBe("moderate");
    expect(bandForDelayRatio(0.999)).toBe("heavy");
  });

  it("clamps anything beyond severe to severe", () => {
    expect(bandForDelayRatio(5)).toBe("severe");
  });

  it("returns null for a negative or non-finite ratio", () => {
    expect(bandForDelayRatio(-0.2)).toBeNull();
    expect(bandForDelayRatio(Number.NaN)).toBeNull();
  });
});
