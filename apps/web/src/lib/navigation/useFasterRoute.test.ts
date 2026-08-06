// @vitest-environment jsdom

import {
  readRouteMatcherCounters,
  resetRouteMatcherCounters,
  setRouteMatcherCounting,
  useNavigationStore,
  useSettingsStore,
} from "@openmapx/core";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useNavRecordingStore } from "./navRecordingStore";

const fetchDirections = vi.fn();
vi.mock("@openmapx/core", async () => {
  const actual = await vi.importActual<typeof import("@openmapx/core")>("@openmapx/core");
  return { ...actual, fetchDirections: (...a: unknown[]) => fetchDirections(...a) };
});

vi.mock("next-intl", () => ({ useLocale: () => "en" }));

import { useFasterRoute } from "./useFasterRoute";

const routeOf = (duration: number, lat: number) => ({
  distance: 20_000,
  duration,
  geometry: [
    [0, lat],
    [0.09, lat],
    [0.18, lat],
  ] as [number, number][],
  legs: [],
  steps: [],
  mode: "driving" as const,
});

const start = (mode: "driving" | "walking" = "driving") => {
  useNavigationStore.getState().stopNavigation();
  useNavigationStore.getState().startGroundNavigation(
    routeOf(3600, 0),
    mode,
    [
      [0, 0],
      [0.18, 0],
    ],
    [],
    undefined,
    {
      routeOptions: {
        avoidHighways: true,
        avoidTolls: true,
        avoidFerries: true,
        avoidClosures: true,
      },
    },
  );
  useNavigationStore.getState().applyProgress({
    snapped: [0.045, 0],
    alongMeters: 5_000,
    deviationMeters: 0,
    segmentIndex: 0,
    etaEpochMs: Date.now() + 4_500_000,
    bearing: 90,
    speedMps: 30,
  } as never);
};

beforeEach(() => {
  vi.useFakeTimers();
  fetchDirections.mockReset();
  fetchDirections.mockResolvedValue({ routes: [], waypoints: [], activeRouteIndex: 0 });
  useSettingsStore.setState({ fasterRoutes: true });
  Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
  start();
});

afterEach(() => {
  vi.useRealTimers();
  useNavigationStore.getState().stopNavigation();
  useNavRecordingStore.setState({ replaying: false });
});

describe("useFasterRoute", () => {
  it("checks after five minutes, not before", async () => {
    renderHook(() => useFasterRoute());
    await act(async () => vi.advanceTimersByTimeAsync(299_000));
    expect(fetchDirections).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    expect(fetchDirections).toHaveBeenCalledTimes(1);
    expect(fetchDirections).toHaveBeenCalledWith(
      expect.objectContaining({
        avoidHighways: true,
        avoidTolls: true,
        avoidFerries: true,
        avoidClosures: true,
      }),
    );
  });

  it("does not check when the setting is off", async () => {
    useSettingsStore.setState({ fasterRoutes: false });
    renderHook(() => useFasterRoute());
    await act(async () => vi.advanceTimersByTimeAsync(310_000));
    expect(fetchDirections).not.toHaveBeenCalled();
  });

  it("withdraws a pending offer when the setting is turned off", () => {
    useNavigationStore.getState().proposeFasterRoute({
      route: routeOf(2700, 0),
      alternatives: [],
      savedSeconds: 900,
      proposedAtMs: Date.now(),
    });
    renderHook(() => useFasterRoute());
    act(() => useSettingsStore.setState({ fasterRoutes: false }));
    expect(useNavigationStore.getState().fasterRoute).toBeNull();
  });

  it("does not check when walking", async () => {
    start("walking");
    renderHook(() => useFasterRoute());
    await act(async () => vi.advanceTimersByTimeAsync(310_000));
    expect(fetchDirections).not.toHaveBeenCalled();
  });

  it("does not check while off-route", async () => {
    useNavigationStore.getState().setOffRoute(true);
    renderHook(() => useFasterRoute());
    await act(async () => vi.advanceTimersByTimeAsync(310_000));
    expect(fetchDirections).not.toHaveBeenCalled();
  });

  it("does not check while offline", async () => {
    Object.defineProperty(navigator, "onLine", { configurable: true, value: false });
    renderHook(() => useFasterRoute());
    await act(async () => vi.advanceTimersByTimeAsync(310_000));
    expect(fetchDirections).not.toHaveBeenCalled();
  });

  it("proposes a qualifying candidate", async () => {
    // Diverges roughly 1 km north well ahead of the driver and saves 900 s.
    fetchDirections.mockResolvedValue({
      routes: [
        {
          ...routeOf(2700, 0),
          geometry: [
            [0.045, 0],
            [0.09, 0],
            [0.11, 0.009],
            [0.18, 0],
          ],
        },
      ],
      waypoints: [],
      activeRouteIndex: 0,
    });
    renderHook(() => useFasterRoute());
    await act(async () => vi.advanceTimersByTimeAsync(301_000));
    expect(useNavigationStore.getState().fasterRoute?.savedSeconds).toBeGreaterThanOrEqual(300);
  });

  it("does not check while replaying a recording", async () => {
    useNavRecordingStore.setState({ replaying: true });
    renderHook(() => useFasterRoute());
    await act(async () => vi.advanceTimersByTimeAsync(310_000));
    expect(fetchDirections).not.toHaveBeenCalled();
  });

  it("withdraws a pending offer when the driver goes off-route", () => {
    useNavigationStore.getState().proposeFasterRoute({
      route: routeOf(2700, 0),
      alternatives: [],
      savedSeconds: 900,
      proposedAtMs: Date.now(),
    });
    renderHook(() => useFasterRoute());
    act(() => useNavigationStore.getState().setOffRoute(true));
    expect(useNavigationStore.getState().fasterRoute).toBeNull();
  });

  it("suppresses faster-route polling for the rest of the trip after dismissal", async () => {
    renderHook(() => useFasterRoute());
    act(() => {
      useNavigationStore.getState().proposeFasterRoute({
        route: routeOf(2700, 0),
        alternatives: [],
        savedSeconds: 900,
        proposedAtMs: Date.now(),
      });
    });
    act(() => {
      useNavigationStore.getState().dismissFasterRoute();
    });
    await act(async () => vi.advanceTimersByTimeAsync(1_800_000));
    expect(fetchDirections).not.toHaveBeenCalled();
    act(() => {
      useNavigationStore.getState().applyReroute(routeOf(3600, 0.5));
      useNavigationStore.getState().applyProgress({
        snapped: [0.045, 0.5],
        alongMeters: 5_000,
        deviationMeters: 0,
        segmentIndex: 0,
        etaEpochMs: Date.now() + 4_500_000,
        bearing: 90,
        speedMps: 30,
      } as never);
    });
    await act(async () => vi.advanceTimersByTimeAsync(300_001));
    expect(fetchDirections).toHaveBeenCalledTimes(1);
  });

  it("survives a failed fetch without proposing", async () => {
    fetchDirections.mockRejectedValue(new Error("offline"));
    renderHook(() => useFasterRoute());
    await act(async () => vi.advanceTimersByTimeAsync(301_000));
    expect(useNavigationStore.getState().fasterRoute).toBeNull();
  });

  describe("remaining-time floor", () => {
    // The first tick fires exactly CHECK_INTERVAL_MS (300 s) after render, so
    // an eta set to `now + 300_000 + N * 1000` reads as N seconds remaining
    // at check time.
    function setRemainingAtFirstCheck(seconds: number) {
      useNavigationStore.getState().applyProgress({
        snapped: [0.045, 0],
        alongMeters: 5_000,
        deviationMeters: 0,
        segmentIndex: 0,
        etaEpochMs: Date.now() + 300_000 + seconds * 1000,
        bearing: 90,
        speedMps: 30,
      } as never);
    }

    it("does not check when 299 s would remain (below the 300 s floor)", async () => {
      setRemainingAtFirstCheck(299);
      renderHook(() => useFasterRoute());
      await act(async () => vi.advanceTimersByTimeAsync(300_000));
      expect(fetchDirections).not.toHaveBeenCalled();
    });

    it("does not check when exactly 300 s would remain (at the floor)", async () => {
      setRemainingAtFirstCheck(300);
      renderHook(() => useFasterRoute());
      await act(async () => vi.advanceTimersByTimeAsync(300_000));
      expect(fetchDirections).not.toHaveBeenCalled();
    });

    it("checks when more than 300 s would remain", async () => {
      setRemainingAtFirstCheck(301);
      renderHook(() => useFasterRoute());
      await act(async () => vi.advanceTimersByTimeAsync(300_000));
      expect(fetchDirections).toHaveBeenCalledTimes(1);
    });
  });

  it("does not overlap a slow request with the next tick", async () => {
    let resolveFirst: (v: unknown) => void = () => {};
    fetchDirections.mockReturnValue(
      new Promise((r) => {
        resolveFirst = r;
      }),
    );
    renderHook(() => useFasterRoute());
    await act(async () => vi.advanceTimersByTimeAsync(300_000));
    expect(fetchDirections).toHaveBeenCalledTimes(1);

    // The next tick fires while the first request is still in flight.
    await act(async () => vi.advanceTimersByTimeAsync(300_000));
    expect(fetchDirections).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveFirst({ routes: [], waypoints: [], activeRouteIndex: 0 });
    });
  });

  describe("index ownership", () => {
    beforeEach(() => {
      resetRouteMatcherCounters();
      setRouteMatcherCounting(true);
    });

    afterEach(() => {
      setRouteMatcherCounting(false);
      resetRouteMatcherCounters();
    });

    it("indexes the active route once and the corridor once per check", async () => {
      // A stop in the middle, so waypoint pruning really projects onto the route.
      useNavigationStore.getState().stopNavigation();
      useNavigationStore.getState().startGroundNavigation(routeOf(3600, 0), "driving", [
        [0, 0],
        [0.09, 0],
        [0.18, 0],
      ]);
      useNavigationStore.getState().applyProgress({
        snapped: [0.045, 0],
        alongMeters: 5_000,
        deviationMeters: 0,
        segmentIndex: 0,
        etaEpochMs: Date.now() + 4_500_000,
        bearing: 90,
        speedMps: 30,
      } as never);
      // Two candidates that stay in the corridor, each with plenty of vertices:
      // no offer fires, and no vertex may build an index of its own.
      const following = (duration: number) => ({
        ...routeOf(duration, 0),
        geometry: Array.from({ length: 12 }, (_, i) => [0.045 + i * 0.0122, 0] as [number, number]),
      });
      fetchDirections.mockResolvedValue({
        routes: [following(3400), following(3500)],
        waypoints: [],
        activeRouteIndex: 0,
      });

      renderHook(() => useFasterRoute());
      await act(async () => vi.advanceTimersByTimeAsync(301_000));
      // The route index the hook owns, plus the corridor sliced for this check.
      expect(readRouteMatcherCounters().preparations).toBe(2);

      await act(async () => vi.advanceTimersByTimeAsync(300_000));
      // Only the freshly sliced corridor is new; the route index is reused.
      expect(readRouteMatcherCounters().preparations).toBe(3);
      expect(useNavigationStore.getState().fasterRoute).toBeNull();
    });
  });

  it("discards a result whose route changed while in flight", async () => {
    let resolve: (v: unknown) => void = () => {};
    fetchDirections.mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    renderHook(() => useFasterRoute());
    await act(async () => vi.advanceTimersByTimeAsync(301_000));
    act(() => {
      useNavigationStore.getState().applyReroute(routeOf(3000, 0.5));
      resolve({
        routes: [
          {
            ...routeOf(2000, 0),
            geometry: [
              [0.045, 0],
              [0.09, 0],
              [0.11, 0.009],
              [0.18, 0],
            ],
          },
        ],
        waypoints: [],
        activeRouteIndex: 0,
      });
    });
    await act(async () => vi.advanceTimersByTimeAsync(10));
    expect(useNavigationStore.getState().fasterRoute).toBeNull();
  });
});
