// @vitest-environment jsdom

import { createNavigationSessionSnapshot, type Route, useNavigationStore } from "@openmapx/core";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import type { NavigationSessionStorage } from "./navigationSessionStorage";
import { useNavigationSessionPersistence } from "./useNavigationSessionPersistence";

const geometry: [number, number][] = [
  [0, 0],
  [0.01, 0],
  [0.02, 0],
];
const route: Route = {
  distance: 2000,
  duration: 100,
  geometry,
  legs: [
    {
      distance: 2000,
      duration: 100,
      geometry,
      steps: [{ instruction: "Continue", distance: 2000, duration: 100, coordinates: geometry }],
    },
  ],
  steps: [{ instruction: "Continue", distance: 2000, duration: 100, coordinates: geometry }],
  mode: "driving",
};

function makeSnapshot() {
  return createNavigationSessionSnapshot({
    route,
    routes: [route],
    activeRouteIndex: 0,
    routeSelectionIntent: "automatic",
    mode: "driving",
    routeOptions: {
      avoidHighways: false,
      avoidTolls: false,
      avoidFerries: false,
      avoidClosures: false,
    },
    routeProvider: null,
    destinationWaypoints: [
      [0, 0],
      [0.02, 0],
    ],
    progress: null,
    packageIds: [],
    startedAtMs: Date.now(),
    updatedAtMs: Date.now(),
  });
}

function memoryStorage(
  initial?: ReturnType<typeof makeSnapshot>,
): NavigationSessionStorage & { writes: unknown[]; cleared: number } {
  let value: unknown = initial;
  const result = {
    writes: [] as unknown[],
    cleared: 0,
    async read() {
      return value as ReturnType<typeof makeSnapshot> | null;
    },
    async write(snapshot: ReturnType<typeof makeSnapshot>) {
      value = snapshot;
      result.writes.push(snapshot);
    },
    async clear() {
      value = undefined;
      result.cleared += 1;
    },
  };
  return result;
}

describe("useNavigationSessionPersistence", () => {
  beforeEach(() => useNavigationStore.getState().stopNavigation());

  it("offers a saved route without entering navigation and accepts explicitly", async () => {
    const storage = memoryStorage(makeSnapshot());
    const { result } = renderHook(() => useNavigationSessionPersistence(storage));
    await waitFor(() => expect(result.current.pending).not.toBeNull());
    expect(useNavigationStore.getState().status).toBe("idle");
    act(() => result.current.accept());
    expect(useNavigationStore.getState().status).toBe("navigating");
    expect(result.current.pending).toBeNull();
  });

  it("writes a new active route and clears it on stop", async () => {
    const storage = memoryStorage();
    renderHook(() => useNavigationSessionPersistence(storage));
    act(() =>
      useNavigationStore.getState().startGroundNavigation(route, "driving", [
        [0, 0],
        [0.02, 0],
      ]),
    );
    await waitFor(() => expect(storage.writes.length).toBe(1));
    act(() => useNavigationStore.getState().stopNavigation());
    await waitFor(() => expect(storage.cleared).toBe(1));
  });

  it("does not persist every progress update inside the checkpoint window", async () => {
    const storage = memoryStorage();
    renderHook(() => useNavigationSessionPersistence(storage));
    act(() =>
      useNavigationStore.getState().startGroundNavigation(route, "driving", [
        [0, 0],
        [0.02, 0],
      ]),
    );
    await waitFor(() => expect(storage.writes.length).toBe(1));
    act(() =>
      useNavigationStore.getState().applyProgress({
        currentStepIndex: 0,
        distanceToNextManeuver: 1900,
        distanceRemaining: 1900,
        durationRemaining: 95,
        snapped: [0.001, 0],
        alongMeters: 100,
        deviationMeters: 0,
        segmentIndex: 0,
        etaEpochMs: Date.now() + 95_000,
        bearing: 90,
        speedMps: 10,
      }),
    );
    expect(storage.writes.length).toBe(1);
  });

  it("discards the pending route without starting navigation", async () => {
    const storage = memoryStorage(makeSnapshot());
    const { result } = renderHook(() => useNavigationSessionPersistence(storage));
    await waitFor(() => expect(result.current.pending).not.toBeNull());
    await act(async () => result.current.discard());
    expect(result.current.pending).toBeNull();
    expect(storage.cleared).toBe(1);
    expect(useNavigationStore.getState().status).toBe("idle");
  });
});
