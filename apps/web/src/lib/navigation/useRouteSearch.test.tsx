// @vitest-environment jsdom

import type { Route } from "@integrations/routing/types";
import {
  type OverpassFilter,
  readRouteMatcherCounters,
  resetRouteMatcherCounters,
  setRouteMatcherCounting,
  useNavigationStore,
} from "@openmapx/core";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({ useLocale: () => "en" }));

// POIs along the corridor, standing in for the category (and, when swapped in
// below, filter) search response. Shared by both branches so the "same shape
// out of either path" test below is comparing against one fixture, not two
// hand-maintained copies that could quietly drift apart.
const places = [
  { id: "a", name: "A", coordinates: [0.001, 0.0002] },
  { id: "b", name: "B", coordinates: [0.002, -0.0003] },
  { id: "c", name: "C", coordinates: [0.003, 0.0001] },
];

// Most of these tests only exercise the category path, so this starts (and is
// reset to) disabled/no-data — that also means it never needs a real
// QueryClientProvider. The filter-branch test below swaps in real data.
let filterSearchResult: {
  data?: { results: typeof places };
  isLoading: boolean;
  isError: boolean;
} = {
  data: undefined,
  isLoading: false,
  isError: false,
};

vi.mock("@openmapx/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@openmapx/core")>();
  return {
    ...actual,
    useCategorySearch: () => ({
      data: { results: places },
      isLoading: false,
      isError: false,
    }),
    useFilterSearch: () => filterSearchResult,
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
    filterSearchResult = { data: undefined, isLoading: false, isError: false };
  });

  it("produces the same AlongRoutePoi shape through the filter path as the category path", () => {
    // Same route, same progress (none published — both hooks read the default
    // alongMeters=0), and the same `places` fixture behind each search hook:
    // the only difference is which of useCategorySearch/useFilterSearch is
    // wired to `active` inside useRouteSearch. If the two paths ever produced
    // different AlongRoutePoi shapes, this equality would catch it — a type
    // annotation alone would not.
    const { result: categoryResult } = renderHook(() => useRouteSearch({ category: "fuel" }));
    expect(categoryResult.current.results.length).toBeGreaterThan(0);
    expect(categoryResult.current.isLoading).toBe(false);
    expect(categoryResult.current.isError).toBe(false);

    filterSearchResult = { data: { results: places }, isLoading: false, isError: false };
    const brandFilter: OverpassFilter = {
      selectors: [{ tags: [{ key: "brand:wikidata", op: "=", value: "Q1" }] }],
    };
    const { result: filterResult } = renderHook(() => useRouteSearch({ filter: brandFilter }));

    expect(filterResult.current.results).toEqual(categoryResult.current.results);
    expect(filterResult.current.results.length).toBe(categoryResult.current.results.length);
    expect(filterResult.current.isLoading).toBe(false);
    expect(filterResult.current.isError).toBe(false);
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
