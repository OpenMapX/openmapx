import { describe, expect, it } from "vitest";
import {
  remainingWaypoints,
  shouldReroute,
  shouldRerouteForClosure,
  updateOffRouteScore,
} from "../reroute";

const opts = {
  thresholdMeters: 45,
  scoreThreshold: 10,
  backoffBaseMs: 3_000,
  backoffMaxMs: 120_000,
};

describe("updateOffRouteScore", () => {
  it("resets to 0 when back on route", () => {
    expect(updateOffRouteScore(8, false, true, false, 5, 5)).toBe(0);
  });

  it("adds 2 per fix while moving off route", () => {
    expect(updateOffRouteScore(0, true, true, false, 60, undefined)).toBe(2);
  });

  it("adds only 1 per fix while slow/stopped off route", () => {
    expect(updateOffRouteScore(0, true, false, false, 60, undefined)).toBe(1);
  });

  it("adds an extra point when heading the wrong way", () => {
    expect(updateOffRouteScore(0, true, true, true, 60, undefined)).toBe(3);
  });

  it("ignores stationary jitter (tiny deviation change while stopped)", () => {
    expect(updateOffRouteScore(4, true, false, false, 60.2, 60)).toBe(4);
  });
});

describe("shouldReroute", () => {
  it("is false below the score threshold", () => {
    expect(shouldReroute(9, null, opts.backoffBaseMs, 0, opts)).toBe(false);
  });

  it("is true at the threshold with no prior reroute", () => {
    expect(shouldReroute(10, null, opts.backoffBaseMs, 0, opts)).toBe(true);
  });

  it("respects the back-off window since the last reroute", () => {
    expect(shouldReroute(10, 1_000, 5_000, 4_000, opts)).toBe(false); // 3 s < 5 s
    expect(shouldReroute(10, 1_000, 5_000, 7_000, opts)).toBe(true); // 6 s > 5 s
  });
});

describe("shouldRerouteForClosure", () => {
  it("triggers when a new closure is ahead and backoff has cleared", () => {
    expect(shouldRerouteForClosure(true, null, 5_000, 0)).toBe(true);
  });

  it("does not trigger when there is no new closure ahead", () => {
    expect(shouldRerouteForClosure(false, null, 5_000, 0)).toBe(false);
  });

  it("respects the backoff window (same as off-route reroute)", () => {
    expect(shouldRerouteForClosure(true, 1_000, 5_000, 4_000)).toBe(false); // 3 s < 5 s
    expect(shouldRerouteForClosure(true, 1_000, 5_000, 7_000)).toBe(true); // 6 s > 5 s
  });

  it("does not trigger when backoff has cleared but there is no new closure", () => {
    // Already-known filtering is the caller's responsibility (engine-level): the
    // engine passes closureAhead=false when every closure in the list is in the
    // knownClosureIdsRef baseline. The pure function just sees no closure → false.
    expect(shouldRerouteForClosure(false, 0, 5_000, 10_000)).toBe(false);
  });
});

describe("remainingWaypoints", () => {
  // Due-east line; 0.001° ≈ 111 m at the equator.
  const geometry: [number, number][] = [
    [0, 0],
    [0.001, 0],
    [0.002, 0],
    [0.003, 0],
  ];

  it("re-anchors the origin for a simple A→B route", () => {
    const wps = remainingWaypoints(
      geometry,
      [
        [0, 0],
        [0.003, 0],
      ],
      [0.0015, 0],
      150,
    );
    expect(wps).toEqual([
      [0.0015, 0],
      [0.003, 0],
    ]);
  });

  it("drops passed intermediate stops but always keeps the destination", () => {
    // Mids at ~111 m and ~222 m; we're ~150 m along → the first is behind us.
    const dest: [number, number][] = [
      [0, 0],
      [0.001, 0],
      [0.002, 0],
      [0.003, 0],
    ];
    const wps = remainingWaypoints(geometry, dest, [0.0015, 0], 150);
    expect(wps).toEqual([
      [0.0015, 0],
      [0.002, 0],
      [0.003, 0],
    ]);
  });
});
