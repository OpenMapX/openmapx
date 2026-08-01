// @vitest-environment jsdom

import { useNavigationStore, useSettingsStore } from "@openmapx/core";
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
  useNavigationStore.getState().startGroundNavigation(routeOf(3600, 0), mode, [
    [0, 0],
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
  });

  it("does not check when the setting is off", async () => {
    useSettingsStore.setState({ fasterRoutes: false });
    renderHook(() => useFasterRoute());
    await act(async () => vi.advanceTimersByTimeAsync(310_000));
    expect(fetchDirections).not.toHaveBeenCalled();
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

  it("suppresses the next poll for ten minutes after dismissal", async () => {
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
    await act(async () => vi.advanceTimersByTimeAsync(599_000));
    expect(fetchDirections).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    expect(fetchDirections).toHaveBeenCalledTimes(1);
  });

  it("survives a failed fetch without proposing", async () => {
    fetchDirections.mockRejectedValue(new Error("offline"));
    renderHook(() => useFasterRoute());
    await act(async () => vi.advanceTimersByTimeAsync(301_000));
    expect(useNavigationStore.getState().fasterRoute).toBeNull();
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
