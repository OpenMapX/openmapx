import type { FixInput } from "@openmapx/core";
import { haversineDistance, useNavigationStore } from "@openmapx/core";
import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nth } from "@/test";
import { useNavSimStore } from "./navSimStore";
import { useSimulatedPosition } from "./useSimulatedPosition";

const ROUTE = {
  distance: 4000,
  duration: 300,
  geometry: [
    [6.6852, 51.1985],
    [6.7, 51.1985],
    [6.72, 51.1985],
  ] as [number, number][],
  legs: [],
  steps: [],
  mode: "driving" as const,
};

beforeEach(() => {
  vi.useFakeTimers();
  useNavigationStore.getState().stopNavigation();
  useNavigationStore.getState().startGroundNavigation(ROUTE as never, "driving", [
    [6.6852, 51.1985],
    [6.72, 51.1985],
  ]);
  useNavSimStore.setState({ enabled: true, speedMps: 14, playbackRate: 1, offsetMeters: 0 });
});

afterEach(() => {
  vi.useRealTimers();
  useNavigationStore.getState().stopNavigation();
  useNavSimStore.setState({ enabled: false, playbackRate: 1, offsetMeters: 0 });
});

describe("useSimulatedPosition", () => {
  it("stamps every fix with wall-clock time", () => {
    const fixes: FixInput[] = [];
    renderHook(() => useSimulatedPosition(true, (fix) => fixes.push(fix)));

    vi.advanceTimersByTime(3000);

    expect(fixes.length).toBeGreaterThan(0);
    // A synthetic fix that carries a zero-based clock makes every epoch derived
    // from it (the ETA, and so the faster-route check) nonsense.
    for (const fix of fixes) {
      expect(fix.timestampMs).toBeGreaterThan(1_700_000_000_000);
    }
  });

  it("advances the timestamp with real time, not the fix index", () => {
    const fixes: FixInput[] = [];
    renderHook(() => useSimulatedPosition(true, (fix) => fixes.push(fix)));

    vi.advanceTimersByTime(1000);
    const first = fixes.at(-1)?.timestampMs ?? 0;
    vi.advanceTimersByTime(5000);
    const later = fixes.at(-1)?.timestampMs ?? 0;

    expect(later - first).toBeGreaterThanOrEqual(4000);
  });

  it("a late tick delivers the position for the time that actually passed", () => {
    const fixes: FixInput[] = [];
    renderHook(() => useSimulatedPosition(true, (fix) => fixes.push(fix)));
    vi.advanceTimersByTime(1000);
    const before = nth(fixes, -1);
    // A busy main thread holds the interval back for a second.
    vi.setSystemTime(Date.now() + 1000);
    vi.advanceTimersByTime(1000);
    const after = nth(fixes, -1);
    // Two seconds at 14 m/s: a one-step fix stamped two seconds later would
    // read as the car falling back, and the puck would bounce.
    expect(haversineDistance(before.coords, after.coords)).toBeCloseTo(28, 0);
  });

  it("a late tick near the end still delivers the final position", () => {
    const fixes: FixInput[] = [];
    renderHook(() => useSimulatedPosition(true, (fix) => fixes.push(fix)));
    // About 2.4 km at 14 m/s: a few seconds short of the end.
    vi.advanceTimersByTime(165_000);
    // Then the main thread stalls past the end of the drive.
    vi.setSystemTime(Date.now() + 30_000);
    vi.advanceTimersByTime(5000);
    expect(haversineDistance(nth(fixes, -1).coords, [6.72, 51.1985])).toBeLessThan(1);
  });

  it("keeps the synthetic position, heading and speed", () => {
    const fixes: FixInput[] = [];
    renderHook(() => useSimulatedPosition(true, (fix) => fixes.push(fix)));

    vi.advanceTimersByTime(2000);

    const fix = nth(fixes, 0);
    expect(fix.coords[1]).toBeCloseTo(51.1985, 4);
    expect(fix.speed).toBeCloseTo(14, 5);
    expect(fix.heading).toBeGreaterThan(0);
  });
});
