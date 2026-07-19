import { describe, expect, it } from "vitest";
import { type CoastOptions, coastState } from "../coast";

const OPTS: CoastOptions = {
  startAfterMs: 3000,
  maxCoastMs: 120_000,
  maxCoastMeters: 3000,
  routeLengthMeters: 10_000,
};

describe("coastState", () => {
  it("does not coast until the fix is older than startAfterMs", () => {
    const r = coastState(100, 20, 2000, OPTS);
    expect(r.coasting).toBe(false);
    expect(r.alongMeters).toBe(100);
    expect(r.speedMps).toBe(20);
  });

  it("coasts forward at roughly the last speed once past the start delay", () => {
    const r = coastState(100, 20, 5000, OPTS);
    expect(r.coasting).toBe(true);
    // ~20 m/s for ~5 s, minus a little deceleration.
    expect(r.alongMeters).toBeGreaterThan(190);
    expect(r.alongMeters).toBeLessThan(200);
    expect(r.speedMps).toBeGreaterThan(18);
    expect(r.speedMps).toBeLessThan(20);
  });

  it("decelerates to a standstill by maxCoastMs and then freezes", () => {
    const atCap = coastState(100, 20, OPTS.maxCoastMs, OPTS);
    expect(atCap.speedMps).toBeCloseTo(0);
    // Integral of a linear ramp 20→0 over 120 s = 20 * 120 / 2 = 1200 m.
    expect(atCap.alongMeters).toBeCloseTo(1300, 0);

    const past = coastState(100, 20, OPTS.maxCoastMs * 2, OPTS);
    expect(past.coasting).toBe(true);
    expect(past.speedMps).toBeCloseTo(0);
    expect(past.alongMeters).toBeCloseTo(1300, 0);
  });

  it("caps the coasted distance at maxCoastMeters", () => {
    const r = coastState(100, 100, OPTS.maxCoastMs, OPTS);
    expect(r.alongMeters).toBe(100 + OPTS.maxCoastMeters);
  });

  it("clamps the coasted distance to the route length near the destination", () => {
    const r = coastState(9950, 20, 5000, OPTS);
    expect(r.alongMeters).toBe(10_000);
  });

  it("stays put but reports estimated when stationary at the outage", () => {
    const r = coastState(500, 0, 5000, OPTS);
    expect(r.coasting).toBe(true);
    expect(r.alongMeters).toBe(500);
    expect(r.speedMps).toBe(0);
  });
});
