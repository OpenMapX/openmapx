import type { LngLat, Route, RouteMatchWindow } from "@openmapx/core";
import { useNavigationStore } from "@openmapx/core";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const match = vi.hoisted(() => ({
  answer: null as null | ((trace: LngLat[]) => RouteMatchWindow),
}));
vi.mock("@openmapx/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@openmapx/core")>()),
  fetchRouteMatchWindow: vi.fn(async (trace: LngLat[]) => match.answer?.(trace)),
}));

import { useNavTrafficSignals } from "./useNavTrafficSignals";

// ~1 m of latitude in degrees: 300 m straight north with a turn at 200 m.
const M = 1 / 111_195;
const geometry: LngLat[] = [
  [13.4, 52.5],
  [13.4, 52.5 + 100 * M],
  [13.4, 52.5 + 200 * M],
  [13.4, 52.5 + 300 * M],
];
const route = {
  distance: 300,
  duration: 30,
  legs: [],
  mode: "driving",
  geometry,
  steps: [
    { instruction: "Head north", distance: 200, duration: 20, coordinates: geometry.slice(0, 3) },
    {
      instruction: "Turn right",
      distance: 100,
      duration: 10,
      coordinates: geometry.slice(2),
      maneuver: { type: "turn", modifier: "right" },
    },
    { instruction: "Arrive", distance: 0, duration: 0, coordinates: [] },
  ],
} as unknown as Route;

const window = (overrides: Partial<RouteMatchWindow>): RouteMatchWindow => ({
  signals: [],
  speedLimitsByPoint: [],
  countriesByPoint: [],
  edges: [],
  geometry,
  failed: false,
  ...overrides,
});

beforeEach(() => {
  useNavigationStore.getState().stopNavigation();
});
afterEach(() => {
  match.answer = null;
  useNavigationStore.getState().stopNavigation();
});

function start() {
  act(() => {
    useNavigationStore
      .getState()
      .startGroundNavigation(route, "driving", [geometry[0] as LngLat, geometry[3] as LngLat]);
  });
}

describe("useNavTrafficSignals approach ways", () => {
  it("publishes the approach way of each manoeuvre in the window", async () => {
    match.answer = () =>
      window({
        edges: [
          { wayId: 11, endShapeIndex: 1 },
          { wayId: 22, endShapeIndex: 2 },
          { wayId: 33, endShapeIndex: 3 },
        ],
      });
    start();
    renderHook(() => useNavTrafficSignals());
    await waitFor(() =>
      expect(useNavigationStore.getState().approachWayIds).toEqual({ 1: 22, 2: 33 }),
    );
  });

  it("a failed window leaves its steps without ids", async () => {
    match.answer = () => window({ failed: true, geometry: [] });
    start();
    renderHook(() => useNavTrafficSignals());
    await waitFor(() => expect(useNavigationStore.getState().liveDataUnavailable).toBe(false));
    expect(useNavigationStore.getState().approachWayIds ?? {}).toEqual({});
  });
});
