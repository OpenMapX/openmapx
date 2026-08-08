import type { FixInput } from "@openmapx/core";
import { useNavigationStore } from "@openmapx/core";
import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

  it("keeps the synthetic position, heading and speed", () => {
    const fixes: FixInput[] = [];
    renderHook(() => useSimulatedPosition(true, (fix) => fixes.push(fix)));

    vi.advanceTimersByTime(2000);

    const fix = fixes[0];
    expect(fix.coords[1]).toBeCloseTo(51.1985, 4);
    expect(fix.speed).toBeCloseTo(14, 5);
    expect(fix.heading).toBeGreaterThan(0);
  });
});
