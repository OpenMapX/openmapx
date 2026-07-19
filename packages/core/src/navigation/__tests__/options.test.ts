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

  it("provides a guidance approach window, with a longer motorway lead for driving", () => {
    for (const m of ["driving", "walking", "cycling"] as const) {
      const g = navOptionsForMode(m).guidance;
      expect(g.leadSeconds).toBeGreaterThan(0);
      expect(g.maxLeadSeconds).toBeGreaterThanOrEqual(g.leadSeconds);
      expect(g.minMeters).toBeGreaterThan(0);
      expect(g.chainSeconds).toBeGreaterThan(0);
    }
    // Driving stretches the most at speed (Autobahn lane changes need warning).
    expect(navOptionsForMode("driving").guidance.maxLeadSeconds).toBeGreaterThan(
      navOptionsForMode("walking").guidance.maxLeadSeconds,
    );
  });
});
