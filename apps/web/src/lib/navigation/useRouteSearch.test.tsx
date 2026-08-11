// @vitest-environment jsdom

import type { Route } from "@integrations/routing/types";
import {
  readRouteMatcherCounters,
  resetRouteMatcherCounters,
  setRouteMatcherCounting,
  useNavigationStore,
} from "@openmapx/core";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({ useLocale: () => "en" }));

// POIs along the corridor, standing in for the category search response.
const places = [
  { id: "a", name: "A", coordinates: [0.001, 0.0002] },
  { id: "b", name: "B", coordinates: [0.002, -0.0003] },
  { id: "c", name: "C", coordinates: [0.003, 0.0001] },
];

vi.mock("@openmapx/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@openmapx/core")>();
  return {
    ...actual,
    useCategorySearch: () => ({
      data: { results: places },
      isLoading: false,
      isError: false,
    }),
    // These tests only exercise the category path; the filter path is stubbed
    // disabled (no data) so it never needs a real QueryClientProvider.
    useFilterSearch: () => ({
      data: undefined,
      isLoading: false,
      isError: false,
    }),
  };
});

import { useRouteSearch } from "./useRouteSearch";

const waypoints: [number, number][] = [
  [0, 0],
  [0.004, 0],
];

/** A route on a fresh geometry array, so its index is genuinely built here. */
const freshRoute = (): Route => {
  const geometry: [number, number][] = [
    [0, 0],
    [0.002, 0],
    [0.004, 0],
  ];
  return {
    distance: 444,
    duration: 60,
    geometry,
    legs: [],
    mode: "driving",
    steps: [],
  } as unknown as Route;
};

const publishProgress = (alongMeters: number) => {
  useNavigationStore.getState().applyProgress({
    snapped: [alongMeters / 111_000, 0],
    alongMeters,
    deviationMeters: 0,
    segmentIndex: 0,
    etaEpochMs: Date.now() + 60_000,
    bearing: 90,
    speedMps: 12,
  } as never);
};

describe("useRouteSearch route index ownership", () => {
  beforeEach(() => {
    useNavigationStore.getState().stopNavigation();
    useNavigationStore.getState().startGroundNavigation(freshRoute(), "driving", waypoints);
    resetRouteMatcherCounters();
    setRouteMatcherCounting(true);
  });

  afterEach(() => {
    setRouteMatcherCounting(false);
    resetRouteMatcherCounters();
    useNavigationStore.getState().stopNavigation();
  });

  it("indexes the route once and reuses it for progress-only refreshes", () => {
    const { result } = renderHook(() => useRouteSearch({ category: "fuel" }));
    expect(result.current.results.length).toBeGreaterThan(0);
    expect(readRouteMatcherCounters().preparations).toBe(1);

    // Five ~1 Hz position updates: each refilters the POIs against the live
    // along-distance, and none of them may rebuild the index.
    for (let i = 1; i <= 5; i++) {
      act(() => publishProgress(10 * i));
    }

    const counters = readRouteMatcherCounters();
    expect(counters.preparations).toBe(1);
    // Every POI is projected on the first pass and on each of the five updates.
    expect(counters.snaps).toBe(places.length * 6);
  });

  it("indexes the replacement route once when the route is swapped", () => {
    const { rerender } = renderHook(() => useRouteSearch({ category: "fuel" }));
    expect(readRouteMatcherCounters().preparations).toBe(1);

    act(() => useNavigationStore.getState().applyReroute(freshRoute()));
    rerender();
    act(() => publishProgress(25));

    expect(readRouteMatcherCounters().preparations).toBe(2);
  });
});
