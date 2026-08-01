import { describe, expect, it } from "vitest";
import { bandForDelayRatio, TRAFFIC_BAND_COLORS } from "./trafficSeverity";

describe("TRAFFIC_BAND_COLORS", () => {
  it("carries the five overlay gradient stops", () => {
    expect(TRAFFIC_BAND_COLORS).toEqual({
      freeFlow: "#2ecc40",
      light: "#ffd500",
      moderate: "#ff8c00",
      heavy: "#e8112d",
      severe: "#7e0023",
    });
  });
});

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

  it("never returns freeFlow, which would imply a verified-clear route", () => {
    for (const r of [0, 0.05, 0.1, 0.3, 0.7, 2]) {
      expect(bandForDelayRatio(r)).not.toBe("freeFlow");
    }
  });

  it("returns null for a negative or non-finite ratio", () => {
    expect(bandForDelayRatio(-0.2)).toBeNull();
    expect(bandForDelayRatio(Number.NaN)).toBeNull();
  });
});
