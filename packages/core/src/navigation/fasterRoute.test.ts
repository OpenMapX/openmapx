import { describe, expect, it } from "vitest";
import type { Route } from "../types/routing";
import { evaluateFasterRoute, FASTER_ROUTE_DEFAULTS } from "./fasterRoute";

// A straight west-east line at the equator; 0.001 deg lon is ~111 m, so these
// coordinates give round, easy-to-reason-about distances.
const lon = (m: number): number => m / 111_320;

const routeOf = (coords: [number, number][], duration: number): Route =>
  ({
    distance: 0,
    duration,
    geometry: coords,
    legs: [],
    steps: [],
    mode: "driving",
  }) as Route;

/** Current route: straight along the equator from 0 to 20 km. */
const current = routeOf(
  [
    [0, 0],
    [lon(10_000), 0],
    [lon(20_000), 0],
  ],
  1800,
);

/** Candidate that stays on the line (same corridor), just quicker. */
const sameCorridor = (duration: number) =>
  routeOf(
    [
      [lon(5_000), 0],
      [lon(20_000), 0],
    ],
    duration,
  );

/** Candidate that leaves the corridor after driving `divergeAfterM`. */
const divergent = (duration: number, divergeAfterM: number) =>
  routeOf(
    [
      [lon(5_000), 0],
      [lon(5_000 + divergeAfterM), 0],
      [lon(5_000 + divergeAfterM + 1_000), 0.009],
      [lon(20_000), 0],
    ],
    duration,
  );

const opts = (speedMps: number) => ({ ...FASTER_ROUTE_DEFAULTS, speedMps });

describe("evaluateFasterRoute", () => {
  it("treats a corridor-following candidate as an ETA refresh, not a switch", () => {
    const r = evaluateFasterRoute(current, 5_000, 1500, [sameCorridor(1400)], opts(30));
    expect(r.refreshedRemainingSeconds).toBe(1400);
    expect(r.faster).toBeNull();
  });

  it("proposes a divergent candidate that saves enough time", () => {
    // Baseline 4500 s, candidate 3600 s -> saves 900 s (20%). Diverges 2 km
    // ahead; at 30 m/s the lead requirement is 1800 m.
    const r = evaluateFasterRoute(current, 5_000, 4500, [divergent(3600, 2_000)], opts(30));
    expect(r.faster).not.toBeNull();
    expect(r.faster?.savedSeconds).toBe(900);
    expect(r.faster?.divergenceMeters).toBeGreaterThanOrEqual(2_000);
  });

  it("rejects a saving under the absolute floor", () => {
    // 240 s saved on a 3000 s remainder: 8% and under 300 s.
    const r = evaluateFasterRoute(current, 5_000, 3000, [divergent(2760, 2_000)], opts(30));
    expect(r.faster).toBeNull();
  });

  it("rejects a saving under the ratio floor", () => {
    // 360 s saved (over the 300 s floor) on a 5400 s remainder = 6.7%.
    const r = evaluateFasterRoute(current, 5_000, 5400, [divergent(5040, 2_000)], opts(30));
    expect(r.faster).toBeNull();
  });

  it("rejects a divergence the driver cannot reach in time", () => {
    // Diverges 300 m ahead; at 30 m/s the requirement is 1800 m.
    const r = evaluateFasterRoute(current, 5_000, 4500, [divergent(3600, 300)], opts(30));
    expect(r.faster).toBeNull();
  });

  it("applies the distance floor when stationary in traffic", () => {
    // Stopped: speed-derived lead is 0, so the 200 m floor governs. 300 m clears it.
    const r = evaluateFasterRoute(current, 5_000, 4500, [divergent(3600, 300)], opts(0));
    expect(r.faster).not.toBeNull();
  });

  it("prefers a same-corridor candidate's duration as the baseline", () => {
    // Caller says 4500 s remain, but the fresh corridor read is 3800 s. The
    // divergent candidate at 3600 s then saves only 200 s, under the floor.
    const r = evaluateFasterRoute(
      current,
      5_000,
      4500,
      [sameCorridor(3800), divergent(3600, 2_000)],
      opts(30),
    );
    expect(r.refreshedRemainingSeconds).toBe(3800);
    expect(r.faster).toBeNull();
  });

  it("picks the fastest of several divergent candidates", () => {
    const r = evaluateFasterRoute(
      current,
      5_000,
      4500,
      [divergent(3600, 2_000), divergent(3000, 2_000)],
      opts(30),
    );
    expect(r.faster?.route.duration).toBe(3000);
  });

  it("returns nothing for an empty candidate list", () => {
    const r = evaluateFasterRoute(current, 5_000, 4500, [], opts(30));
    expect(r).toEqual({ refreshedRemainingSeconds: null, faster: null });
  });

  it("does not throw on a degenerate current geometry", () => {
    const degenerate = routeOf([[0, 0]], 100);
    expect(() =>
      evaluateFasterRoute(degenerate, 0, 100, [sameCorridor(90)], opts(10)),
    ).not.toThrow();
  });

  it("anchors the corridor at the driver's interpolated position, not the next vertex", () => {
    // 5 km is halfway through the first 10 km segment. The candidate starts at
    // that interpolated point, so it must match the corridor from the driver;
    // starting the corridor at the next vertex would falsely report a 5 km
    // divergence at candidate distance zero.
    const r = evaluateFasterRoute(current, 5_000, 1500, [sameCorridor(1400)], opts(30));
    expect(r.faster).toBeNull();
    expect(r.refreshedRemainingSeconds).toBe(1400);
  });
});

describe("evaluateFasterRoute — shortcuts that hug the corridor", () => {
  // A route that overshoots to 12 km, doubles back to 6 km, then runs to 20 km.
  // Every point of it lies on the same straight line, which is exactly what a
  // missed-turn reroute or a service-road loop looks like: a candidate cutting
  // it out is nowhere more than a few metres off the corridor laterally.
  const doublesBack = routeOf(
    [
      [0, 0],
      [lon(12_000), 0],
      [lon(6_000), 0],
      [lon(20_000), 0],
    ],
    3600,
  );

  /** Straight through, skipping the doubling-back. */
  const shortcut = (duration: number) =>
    routeOf(
      [
        [0, 0],
        [lon(4_000), 0],
        [lon(8_000), 0],
        [lon(20_000), 0],
      ],
      duration,
    );

  it("does not mistake a shortcut for the corridor it skips", () => {
    const r = evaluateFasterRoute(doublesBack, 0, 3600, [shortcut(2400)], opts(30));
    // Adopting 2400 as a "fresh baseline" would be the real damage: it lowers
    // the bar every other candidate is measured against.
    expect(r.refreshedRemainingSeconds).toBeNull();
  });

  it("offers the shortcut, branching where the skip begins", () => {
    const r = evaluateFasterRoute(doublesBack, 0, 3600, [shortcut(2400)], opts(30));
    expect(r.faster).not.toBeNull();
    expect(r.faster?.savedSeconds).toBe(1200);
    // The corridor turns back at 12 km, so that is the true branch. The skip is
    // only visible at the 20 km vertex — the first whose corridor projection
    // jumps — so the branch is reported at the 8 km vertex before it. Under-
    // stating it is the safe direction: it can only make the lead-time gate
    // stricter, never propose a turn the driver has already passed.
    expect(r.faster?.divergenceMeters).toBeCloseTo(8_000, -2);
    expect(r.faster?.divergenceMeters ?? 0).toBeLessThan(12_000);
  });

  it("still treats a genuinely coincident candidate as the same corridor", () => {
    const identical = routeOf(
      [
        [0, 0],
        [lon(12_000), 0],
        [lon(6_000), 0],
        [lon(20_000), 0],
      ],
      3400,
    );
    const r = evaluateFasterRoute(doublesBack, 0, 3600, [identical], opts(30));
    expect(r.refreshedRemainingSeconds).toBe(3400);
    expect(r.faster).toBeNull();
  });
});
