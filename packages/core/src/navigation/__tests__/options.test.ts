import { describe, expect, it } from "vitest";
import { navOptionsForMode } from "../options";

describe("navOptionsForMode", () => {
  it("uses a wider off-route threshold for driving than walking", () => {
    expect(navOptionsForMode("driving").reroute.thresholdMeters).toBeGreaterThan(
      navOptionsForMode("walking").reroute.thresholdMeters,
    );
  });

  it("provides voice config and an arrival threshold for every ground mode", () => {
    for (const m of ["driving", "walking", "cycling"] as const) {
      const o = navOptionsForMode(m);
      expect(o.voice.farMeters).toBeGreaterThan(o.voice.nearMeters);
      expect(o.voice.refSpeedMps).toBeGreaterThan(0);
      expect(o.announceMultiplier).toBe(1);
      expect(o.arrivalThresholdMeters).toBeGreaterThan(0);
    }
  });

  it("provides a positive lane-guidance distance, wider for driving than walking", () => {
    for (const m of ["driving", "walking", "cycling"] as const) {
      expect(navOptionsForMode(m).laneGuidanceMeters).toBeGreaterThan(0);
    }
    expect(navOptionsForMode("driving").laneGuidanceMeters).toBeGreaterThan(
      navOptionsForMode("walking").laneGuidanceMeters,
    );
  });
});
