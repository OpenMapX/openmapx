// @vitest-environment jsdom

import type { Route } from "@integrations/routing/types";
import { type FixInput, useNavigationStore, useSettingsStore } from "@openmapx/core";
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useNavigationEngine } from "./useNavigationEngine";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
  useLocale: () => "en",
}));

let fixHandler: ((fix: FixInput) => void) | null = null;
vi.mock("../useWatchPosition", () => ({
  useWatchPosition: (_active: boolean, onFix: (f: FixInput) => void) => {
    fixHandler = onFix;
  },
}));
vi.mock("./useNavigationVoice", () => ({ useNavigationVoice: () => vi.fn() }));
const fetchDirections = vi.fn();
vi.mock("@openmapx/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@openmapx/core")>();
  return { ...actual, fetchDirections: (...a: unknown[]) => fetchDirections(...a) };
});

const geometry: [number, number][] = [
  [0, 0],
  [0.002, 0],
  [0.004, 0],
];
const route = {
  distance: 444,
  duration: 60,
  geometry,
  legs: [],
  mode: "driving",
  steps: [
    { instruction: "Head east", distance: 222, duration: 30, coordinates: geometry.slice(0, 2) },
    { instruction: "Arrive", distance: 222, duration: 30, coordinates: geometry.slice(1, 3) },
  ],
} as unknown as Route;

describe("useNavigationEngine", () => {
  beforeEach(() => {
    useNavigationStore.getState().stopNavigation();
    // Live road-conditions polling writes to the store from a resolved promise,
    // which would otherwise sprinkle unrelated publications over a fix.
    useSettingsStore.setState({ incidentAlerts: false, avoidIncidents: false });
    fixHandler = null;
    fetchDirections.mockReset();
  });

  it("writes progress to the store on each on-route fix", () => {
    useNavigationStore.getState().startGroundNavigation(route, "driving", [
      [0, 0],
      [0.004, 0],
    ]);
    renderHook(() => useNavigationEngine());
    act(() => fixHandler?.({ coords: [0.001, 0], accuracy: 5, timestampMs: 1000 }));
    expect(useNavigationStore.getState().progress?.currentStepIndex).toBe(0);
  });

  it("requests a reroute and applies the new route when off-route", async () => {
    useNavigationStore.getState().startGroundNavigation(route, "driving", [
      [0, 0],
      [0.004, 0],
    ]);
    const route2 = { ...route, distance: 999 } as Route;
    fetchDirections.mockResolvedValue({ routes: [route2], activeRouteIndex: 0 });
    renderHook(() => useNavigationEngine());
    // Enough moving, off-route fixes (each ~222 m off the line) to accrue the
    // off-route score past the reroute threshold. They advance east, parallel to
    // the route, so this reads as a deviation rather than a wrong-way turn.
    const offFixes: FixInput[] = [
      { coords: [0.001, 0.002], accuracy: 5, speed: 15, timestampMs: 1000 },
      { coords: [0.0012, 0.002], accuracy: 5, speed: 15, timestampMs: 2000 },
      { coords: [0.0014, 0.002], accuracy: 5, speed: 15, timestampMs: 3000 },
      { coords: [0.0016, 0.002], accuracy: 5, speed: 15, timestampMs: 4000 },
      { coords: [0.0018, 0.002], accuracy: 5, speed: 15, timestampMs: 5000 },
      { coords: [0.002, 0.002], accuracy: 5, speed: 15, timestampMs: 6000 },
    ];
    await act(async () => {
      for (const f of offFixes) fixHandler?.(f);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(fetchDirections).toHaveBeenCalled();
    expect(fetchDirections).toHaveBeenCalledWith(
      expect.objectContaining({
        // The fifth fix reaches the score threshold. A reroute must start at
        // that raw GPS position, not its projection onto the obsolete route.
        waypoints: [offFixes[4].coords, [0.004, 0]],
      }),
    );
    expect(useNavigationStore.getState().route?.distance).toBe(999);
  });

  it("keeps the old route and suppresses directions while offline", async () => {
    useNavigationStore.getState().startGroundNavigation(route, "driving", [
      [0, 0],
      [0.004, 0],
    ]);
    useNavigationStore.getState().setConnectivity("offline");
    renderHook(() => useNavigationEngine());
    const offFixes: FixInput[] = [
      { coords: [0.001, 0.002], accuracy: 5, speed: 15, timestampMs: 1000 },
      { coords: [0.0012, 0.002], accuracy: 5, speed: 15, timestampMs: 2000 },
      { coords: [0.0014, 0.002], accuracy: 5, speed: 15, timestampMs: 3000 },
      { coords: [0.0016, 0.002], accuracy: 5, speed: 15, timestampMs: 4000 },
      { coords: [0.0018, 0.002], accuracy: 5, speed: 15, timestampMs: 5000 },
      { coords: [0.002, 0.002], accuracy: 5, speed: 15, timestampMs: 6000 },
    ];
    await act(async () => {
      for (const fix of offFixes) fixHandler?.(fix);
      await Promise.resolve();
    });
    expect(fetchDirections).toHaveBeenCalledTimes(0);
    expect(useNavigationStore.getState().route?.distance).toBe(444);
    expect(useNavigationStore.getState().rerouteUnavailable).toBe(true);
    expect(useNavigationStore.getState().status).toBe("navigating");
  });

  it("allows one deliberate retry after connectivity returns", async () => {
    useNavigationStore.getState().startGroundNavigation(route, "driving", [
      [0, 0],
      [0.004, 0],
    ]);
    useNavigationStore.getState().setConnectivity("online");
    useNavigationStore.getState().setRerouteUnavailable(true);
    useNavigationStore.getState().requestRerouteRetry();
    const route2 = { ...route, distance: 1111 } as Route;
    fetchDirections.mockResolvedValue({ routes: [route2], activeRouteIndex: 0 });
    renderHook(() => useNavigationEngine());
    const offFixes: FixInput[] = [
      { coords: [0.001, 0.002], accuracy: 5, speed: 15, timestampMs: 1000 },
      { coords: [0.0012, 0.002], accuracy: 5, speed: 15, timestampMs: 2000 },
      { coords: [0.0014, 0.002], accuracy: 5, speed: 15, timestampMs: 3000 },
      { coords: [0.0016, 0.002], accuracy: 5, speed: 15, timestampMs: 4000 },
      { coords: [0.0018, 0.002], accuracy: 5, speed: 15, timestampMs: 5000 },
      { coords: [0.002, 0.002], accuracy: 5, speed: 15, timestampMs: 6000 },
    ];
    await act(async () => {
      for (const fix of offFixes) fixHandler?.(fix);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(fetchDirections).toHaveBeenCalledTimes(1);
    expect(useNavigationStore.getState().route?.distance).toBe(1111);
    expect(useNavigationStore.getState().rerouteUnavailable).toBe(false);
  });
});

describe("useNavigationEngine fix publications", () => {
  const waypoints: [number, number][] = [
    [0, 0],
    [0.004, 0],
  ];
  // On the first geometry segment, ~111 m along the route.
  const onRouteFix: FixInput = { coords: [0.001, 0], accuracy: 5, timestampMs: 1000 };

  beforeEach(() => {
    useNavigationStore.getState().stopNavigation();
    useSettingsStore.setState({ incidentAlerts: false, avoidIncidents: false });
    fixHandler = null;
    fetchDirections.mockReset();
  });

  /** Deliver one fix and report how many times the store notified subscribers. */
  function publicationsForFix(fix: FixInput): number {
    let count = 0;
    const unsubscribe = useNavigationStore.subscribe(() => {
      count += 1;
    });
    act(() => fixHandler?.(fix));
    unsubscribe();
    return count;
  }

  it("publishes one combined update for an accepted driving fix", () => {
    const limited = { ...route, segmentSpeedLimits: [50, 70] } as Route;
    useNavigationStore.getState().startGroundNavigation(limited, "driving", waypoints);
    renderHook(() => useNavigationEngine());

    expect(publicationsForFix(onRouteFix)).toBe(1);
    const s = useNavigationStore.getState();
    expect(s.progress?.currentStepIndex).toBe(0);
    expect(s.weakGps).toBe(false);
    expect(s.offRoute).toBe(false);
    expect(s.currentSpeedLimit).toBe(50);
    expect(s.coasting).toBe(false);
  });

  it("falls back to the live map-matched speed limit", () => {
    useNavigationStore.getState().startGroundNavigation(route, "driving", waypoints);
    renderHook(() => useNavigationEngine());
    useNavigationStore.getState().setLiveSpeedLimits([80, 100]);

    expect(publicationsForFix(onRouteFix)).toBe(1);
    expect(useNavigationStore.getState().currentSpeedLimit).toBe(80);
  });

  it("falls back to the step speed limit when nothing is indexed by segment", () => {
    const stepLimited = {
      ...route,
      steps: [{ ...route.steps[0], speedLimit: 30 }, route.steps[1]],
    } as Route;
    useNavigationStore.getState().startGroundNavigation(stepLimited, "driving", waypoints);
    renderHook(() => useNavigationEngine());

    expect(publicationsForFix(onRouteFix)).toBe(1);
    expect(useNavigationStore.getState().currentSpeedLimit).toBe(30);
  });

  it("clears the speed limit for walking in that same update", () => {
    const limited = { ...route, segmentSpeedLimits: [50, 70] } as Route;
    useNavigationStore.getState().startGroundNavigation(limited, "walking", waypoints);
    renderHook(() => useNavigationEngine());
    useNavigationStore.getState().setSpeedLimit(99);

    expect(publicationsForFix(onRouteFix)).toBe(1);
    const s = useNavigationStore.getState();
    expect(s.currentSpeedLimit).toBeNull();
    expect(s.progress?.currentStepIndex).toBe(0);
  });

  it("keeps coasting alive for a coasted fix, and one publication", () => {
    useNavigationStore.getState().startGroundNavigation(route, "driving", waypoints);
    renderHook(() => useNavigationEngine());
    useNavigationStore.getState().setCoasting(true);

    expect(publicationsForFix({ ...onRouteFix, coasted: true })).toBe(1);
    const s = useNavigationStore.getState();
    expect(s.coasting).toBe(true);
    expect(s.progress?.alongMeters).toBeGreaterThan(0);
  });

  it("keeps the last progress on an accuracy-rejected fix and stops republishing", () => {
    useNavigationStore.getState().startGroundNavigation(route, "driving", waypoints);
    renderHook(() => useNavigationEngine());
    act(() => fixHandler?.(onRouteFix));
    const accepted = useNavigationStore.getState().progress;

    // Way past the driving accuracy cap, so the fix never becomes progress.
    const rejected: FixInput = { coords: [0.0015, 0], accuracy: 500, timestampMs: 2000 };
    expect(publicationsForFix(rejected)).toBe(1);
    expect(useNavigationStore.getState().weakGps).toBe(true);
    expect(useNavigationStore.getState().progress).toBe(accepted);

    // Weak GPS is already flagged; a second bad fix must not publish again.
    expect(publicationsForFix({ ...rejected, timestampMs: 3000 })).toBe(0);
    expect(useNavigationStore.getState().progress).toBe(accepted);
  });
});
