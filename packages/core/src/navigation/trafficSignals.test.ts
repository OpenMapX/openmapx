import type { MatchResult } from "@integrations/routing/types";
import { describe, expect, it } from "vitest";

import { extractTrafficSignals, windowGeometry } from "./trafficSignals";

function match(partial: Partial<MatchResult>): MatchResult {
  return {
    geometry: [],
    edges: [],
    points: [],
    mode: "driving",
    ...partial,
  };
}

describe("extractTrafficSignals", () => {
  const geometry = [
    [6.95, 50.94],
    [6.96, 50.95],
    [6.97, 50.95],
    [6.98, 50.96],
  ] as const;

  it("returns the end-node coordinate of flagged edges", () => {
    const res = extractTrafficSignals(
      match({
        geometry: geometry.map((c) => [...c]),
        edges: [
          { length: 1, beginShapeIndex: 0, endShapeIndex: 1, endNodeTrafficSignal: true },
          { length: 1, beginShapeIndex: 1, endShapeIndex: 2 },
          { length: 1, beginShapeIndex: 2, endShapeIndex: 3, endNodeTrafficSignal: true },
        ],
      }),
    );
    expect(res).toEqual([
      [6.96, 50.95],
      [6.98, 50.96],
    ]);
  });

  it("dedupes a node shared by consecutive flagged edges", () => {
    const res = extractTrafficSignals(
      match({
        geometry: geometry.map((c) => [...c]),
        edges: [
          { length: 1, beginShapeIndex: 0, endShapeIndex: 1, endNodeTrafficSignal: true },
          { length: 1, beginShapeIndex: 1, endShapeIndex: 1, endNodeTrafficSignal: true },
        ],
      }),
    );
    expect(res).toEqual([[6.96, 50.95]]);
  });

  it("ignores edges whose endShapeIndex is out of range", () => {
    const res = extractTrafficSignals(
      match({
        geometry: geometry.map((c) => [...c]),
        edges: [{ length: 1, beginShapeIndex: 0, endShapeIndex: 99, endNodeTrafficSignal: true }],
      }),
    );
    expect(res).toEqual([]);
  });

  it("returns [] when there are no edges", () => {
    expect(extractTrafficSignals(match({ geometry: geometry.map((c) => [...c]) }))).toEqual([]);
  });
});

describe("windowGeometry", () => {
  // 6 points; consecutive points well over 1m apart so endMeters is positive.
  const geo = [
    [0, 0],
    [0, 0.001],
    [0, 0.002],
    [0, 0.003],
    [0, 0.004],
    [0, 0.005],
  ] as [number, number][];

  it("returns the whole geometry in one window when under the cap", () => {
    const w = windowGeometry(geo, 0, 100);
    expect(w.trace).toHaveLength(6);
    expect(w.done).toBe(true);
    expect(w.endMeters).toBeGreaterThan(0);
  });

  it("caps the window at maxPoints and reports the next start", () => {
    const w = windowGeometry(geo, 0, 3);
    expect(w.trace).toHaveLength(3);
    expect(w.done).toBe(false);
    // overlap by one point: next window starts at the last point of this one
    expect(w.nextStart).toBe(2);
  });

  it("advances from a mid-route start and terminates", () => {
    const w = windowGeometry(geo, 2, 3);
    expect(w.trace).toEqual([
      [0, 0.002],
      [0, 0.003],
      [0, 0.004],
    ]);
    expect(w.done).toBe(false);
    expect(w.nextStart).toBe(4);
    const last = windowGeometry(geo, w.nextStart, 3);
    expect(last.done).toBe(true);
  });

  it("treats degenerate geometry as done with an empty trace", () => {
    const w = windowGeometry([[0, 0]], 0, 100);
    expect(w.trace).toEqual([]);
    expect(w.done).toBe(true);
    expect(w.endMeters).toBe(0);
  });

  it("is done with an empty trace when starting at the last point", () => {
    const w = windowGeometry(geo, 5, 3);
    expect(w.trace).toEqual([]);
    expect(w.done).toBe(true);
    expect(w.nextStart).toBe(6);
  });
});
