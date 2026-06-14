// @vitest-environment jsdom

import type { Route } from "@integrations/routing/types";
import { type FixInput, useNavigationStore } from "@openmapx/core";
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
    expect(useNavigationStore.getState().route?.distance).toBe(999);
  });
});
