// @vitest-environment jsdom

import type { Route } from "@integrations/routing/types";
import {
  type DirectionsResult,
  type OverpassFilter,
  readRouteMatcherCounters,
  resetRouteMatcherCounters,
  setRouteMatcherCounting,
  useNavigationStore,
} from "@openmapx/core";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({ useLocale: () => "en" }));
const directions = vi.hoisted(() => vi.fn());

// POIs along the corridor, standing in for the category search response.
const places = [
  { id: "a", name: "A", coordinates: [0.001, 0.0002] },
  { id: "b", name: "B", coordinates: [0.002, -0.0003] },
  { id: "c", name: "C", coordinates: [0.003, 0.0001] },
];
let categoryPlaces: ((typeof places)[number] & { routingEntrance?: [number, number] })[] = places;

// A deliberately different-shaped fixture for the filter search response —
// different ids, names, coordinates, *and* length (2 vs 3) from `places`. If
// the filter-path render below ever picked up `places` instead — e.g. because
// `active` inside useRouteSearch stopped selecting `useFilterSearch` — the
// results would come back as 3 items with `places`' ids, not 2 with these,
// and the assertions below would catch it.
const filterPlaces = [
  { id: "x", name: "X", coordinates: [0.0015, 0.0004] },
  { id: "y", name: "Y", coordinates: [0.0035, -0.0002] },
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
    fetchDirections: directions,
    useCategorySearch: () => ({
      data: { results: categoryPlaces },
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
  it("uses the selected identity for co-located stops with different entrances", async () => {
    categoryPlaces = [
      { ...places[0], id: "a", routingEntrance: [0.0019, 0] },
      { ...places[0], id: "b", routingEntrance: [0.0021, 0] },
    ];
    const { result } = renderHook(() => useRouteSearch({ category: "fuel" }));
    await act(async () => {});
    directions.mockResolvedValue({
      waypoints,
      activeRouteIndex: 0,
      provider: "routing-fixture",
      routes: [freshRoute()],
    });
    await act(async () => {
      expect(await result.current.addStop({ id: "b", coordinates: [0.001, 0.0002] } as never)).toBe(
        true,
      );
    });
    expect(useNavigationStore.getState().destinationWaypoints[1]).toEqual([0.0021, 0]);
  });
  it("pins and retains the baseline-selected provider when the active route has none", async () => {
    directions.mockResolvedValue({
      waypoints,
      activeRouteIndex: 0,
      provider: "routing-a",
      routes: [freshRoute()],
    });
    const { result } = renderHook(() => useRouteSearch({ category: "fuel" }));
    await waitFor(() => expect(result.current.results[0].detour?.kind).toBe("network"));
    directions.mockClear();
    await act(async () => {
      expect(await result.current.addStop([0.001, 0.0002])).toBe(true);
    });
    expect(directions.mock.calls[0][0]).toMatchObject({ provider: "routing-a" });
    expect(useNavigationStore.getState().routeProvider).toBe("routing-a");
  });
  it("rejects an old entrance after the selected candidate target refreshes", async () => {
    const { result, rerender } = renderHook(() => useRouteSearch({ category: "fuel" }));
    let finish!: (value: DirectionsResult) => void;
    let requested = false;
    directions.mockImplementation(() => {
      if (requested) return Promise.reject(new Error("offline"));
      requested = true;
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    let pending!: Promise<boolean>;
    act(() => {
      pending = result.current.addStop([0.001, 0.0002]);
    });
    const signal = (directions.mock.calls.at(-1)?.[2] as { signal: AbortSignal }).signal;
    categoryPlaces = places.map((p) => (p.id === "a" ? { ...p, coordinates: [0.0019, 0] } : p));
    rerender();
    expect(signal.aborted).toBe(true);
    await act(async () => {
      finish({
        waypoints,
        activeRouteIndex: 0,
        provider: "routing-fixture",
        routes: [freshRoute()],
      });
      expect(await pending).toBe(false);
    });
    expect(useNavigationStore.getState().destinationWaypoints).toEqual(waypoints);
    expect(useNavigationStore.getState().status).toBe("navigating");
  });
  beforeEach(() => {
    directions.mockReset().mockRejectedValue(new Error("offline"));
    useNavigationStore.getState().stopNavigation();
    useNavigationStore.getState().startGroundNavigation(freshRoute(), "driving", waypoints);
    resetRouteMatcherCounters();
    setRouteMatcherCounting(true);
  });

  it("publishes network deltas and keeps provider/options on every comparison", async () => {
    const route = freshRoute();
    useNavigationStore
      .getState()
      .startGroundNavigation(route, "driving", waypoints, [], "routing-fixture", {
        routeOptions: {
          avoidTolls: true,
          avoidHighways: true,
          avoidFerries: true,
          avoidClosures: true,
        },
      });
    directions.mockImplementation(async (value: unknown) => {
      const { waypoints: points } = value as { waypoints: [number, number][] };
      return {
        waypoints,
        activeRouteIndex: 0,
        provider: "routing-fixture",
        routes: [
          {
            ...route,
            duration: points.length === 2 ? 60 : 180,
            distance: points.length === 2 ? 444 : 1444,
          },
        ],
      };
    });
    const { result } = renderHook(() => useRouteSearch({ category: "fuel" }));
    await waitFor(() => expect(result.current.results[0].detour?.kind).toBe("network"));
    expect(result.current.results[0].detourSeconds).toBe(120);
    expect(result.current.results[0].detourMeters).toBe(1000);
    for (const [params, , options] of directions.mock.calls) {
      expect(params).toMatchObject({
        provider: "routing-fixture",
        avoidTolls: true,
        avoidHighways: true,
        avoidFerries: true,
        avoidClosures: true,
      });
      expect((options as { signal: AbortSignal } | undefined)?.signal).toBeInstanceOf(AbortSignal);
    }
    const calls = directions.mock.calls.length;
    for (let i = 1; i <= 5; i++) act(() => publishProgress(i * 10));
    expect(directions).toHaveBeenCalledTimes(calls);
  });

  it("invalidates a held network claim immediately after provider changes", async () => {
    const route = freshRoute();
    directions.mockResolvedValue({
      waypoints,
      activeRouteIndex: 0,
      provider: "routing-fixture",
      routes: [route],
    });
    const { result } = renderHook(() => useRouteSearch({ category: "fuel" }));
    await waitFor(() => expect(result.current.results[0].detour?.kind).toBe("network"));
    directions.mockReturnValue(new Promise(() => {}));
    act(() => useNavigationStore.setState({ routeProvider: "routing-other" }));
    expect(result.current.results[0].detour?.kind).not.toBe("network");
  });

  it("rejects a late added stop after another session starts with the same route", async () => {
    const { result } = renderHook(() => useRouteSearch(null));
    const original = useNavigationStore.getState().route!;
    let finish!: (result: DirectionsResult) => void;
    directions.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    let pending!: Promise<boolean>;
    act(() => {
      pending = result.current.addStop([0.002, 0.0002]);
    });
    act(() => {
      useNavigationStore.getState().stopNavigation();
      useNavigationStore.getState().startGroundNavigation(original, "driving", waypoints);
    });
    await act(async () => {
      finish({
        waypoints,
        activeRouteIndex: 0,
        provider: "routing-fixture",
        routes: [freshRoute()],
      });
      expect(await pending).toBe(false);
    });
    expect(useNavigationStore.getState().destinationWaypoints).toEqual(waypoints);
    expect(useNavigationStore.getState().route).toBe(original);
  });

  it("cancels its stop request and restores navigation without committing a late response", async () => {
    const { result } = renderHook(() => useRouteSearch(null));
    const original = useNavigationStore.getState().route;
    let finish!: (value: DirectionsResult) => void;
    directions.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    let pending!: Promise<boolean>;
    act(() => {
      pending = result.current.addStop([0.002, 0.0002]);
    });
    const signal = (directions.mock.calls[0][2] as { signal: AbortSignal } | undefined)?.signal;
    act(() => result.current.cancelAddStop());
    expect(signal?.aborted).toBe(true);
    expect(useNavigationStore.getState().status).toBe("navigating");
    await act(async () => {
      finish({
        waypoints,
        activeRouteIndex: 0,
        provider: "routing-fixture",
        routes: [freshRoute()],
      });
      expect(await pending).toBe(false);
    });
    expect(useNavigationStore.getState().route).toBe(original);
  });

  it("lets only the latest competing stop selection commit", async () => {
    const { result } = renderHook(() => useRouteSearch(null));
    const finishes: ((value: DirectionsResult) => void)[] = [];
    directions.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishes.push(resolve);
        }),
    );
    let first!: Promise<boolean>;
    let second!: Promise<boolean>;
    act(() => {
      first = result.current.addStop([0.001, 0.0002]);
    });
    act(() => {
      second = result.current.addStop([0.003, 0.0002]);
    });
    expect(directions).toHaveBeenCalledTimes(2);
    await act(async () => {
      finishes[1]({
        waypoints,
        activeRouteIndex: 0,
        provider: "routing-fixture",
        routes: [freshRoute()],
      });
      expect(await second).toBe(true);
    });
    await act(async () => {
      finishes[0]({
        waypoints,
        activeRouteIndex: 0,
        provider: "routing-fixture",
        routes: [freshRoute()],
      });
      expect(await first).toBe(false);
    });
    expect(useNavigationStore.getState().destinationWaypoints).toEqual([
      waypoints[0],
      [0.003, 0.0002],
      waypoints[1],
    ]);
  });

  it("expires held estimates without polling the provider", async () => {
    vi.useFakeTimers();
    try {
      directions.mockResolvedValue({
        waypoints,
        activeRouteIndex: 0,
        provider: "routing-fixture",
        routes: [freshRoute()],
      });
      const { result } = renderHook(() => useRouteSearch({ category: "fuel" }));
      await act(async () => {});
      expect(result.current.results[0].detour?.kind).toBe("network");
      const calls = directions.mock.calls.length;
      await act(async () => vi.advanceTimersByTimeAsync(60_001));
      expect(result.current.results[0].detour?.kind).not.toBe("network");
      expect(directions).toHaveBeenCalledTimes(calls);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not evaluate or add stops in a native-owned session", async () => {
    useNavigationStore.setState({ navigationAuthority: "native" });
    const { result } = renderHook(() => useRouteSearch({ category: "fuel" }));
    expect(await result.current.addStop([0.002, 0.0002])).toBe(false);
    expect(directions).not.toHaveBeenCalled();
  });

  it("aborts evaluation on unmount and never issues remaining candidate requests", async () => {
    let finish!: (value: DirectionsResult) => void;
    directions.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const { unmount } = renderHook(() => useRouteSearch({ category: "fuel" }));
    const signal = (directions.mock.calls[0]?.[2] as { signal: AbortSignal } | undefined)?.signal;
    unmount();
    expect(signal?.aborted).toBe(true);
    await act(async () =>
      finish({
        waypoints,
        activeRouteIndex: 0,
        provider: "routing-fixture",
        routes: [freshRoute()],
      }),
    );
    expect(directions).toHaveBeenCalledTimes(1);
  });

  afterEach(() => {
    setRouteMatcherCounting(false);
    resetRouteMatcherCounters();
    useNavigationStore.setState({ navigationAuthority: "browser" });
    useNavigationStore.getState().stopNavigation();
    filterSearchResult = { data: undefined, isLoading: false, isError: false };
    categoryPlaces = places;
  });

  it("selects the filter search over the category search when a filter is given", () => {
    // Same route, same progress (none published — both hooks read the default
    // alongMeters=0). The category and filter mocks return deliberately
    // different fixtures (`places` vs `filterPlaces`, 3 items vs 2, disjoint
    // ids), so the filter-path render's `results` can only match `filterPlaces`
    // if `active` inside useRouteSearch actually picked `useFilterSearch`. If
    // `active` were inverted or hardcoded to the category hook, this render
    // would come back with `places`' 3 ids instead and the assertions below
    // would fail.
    const { result: categoryResult } = renderHook(() => useRouteSearch({ category: "fuel" }));
    expect(categoryResult.current.results.length).toBe(places.length);
    expect(categoryResult.current.results.map((r) => r.place.id).sort()).toEqual(["a", "b", "c"]);
    expect(categoryResult.current.isLoading).toBe(false);
    expect(categoryResult.current.isError).toBe(false);

    filterSearchResult = { data: { results: filterPlaces }, isLoading: false, isError: false };
    const brandFilter: OverpassFilter = {
      selectors: [{ tags: [{ key: "brand:wikidata", op: "=", value: "Q1" }] }],
    };
    const { result: filterResult } = renderHook(() => useRouteSearch({ filter: brandFilter }));

    expect(filterResult.current.results.length).toBe(filterPlaces.length);
    expect(filterResult.current.results.map((r) => r.place.id).sort()).toEqual(["x", "y"]);
    expect(filterResult.current.isLoading).toBe(false);
    expect(filterResult.current.isError).toBe(false);

    // The two paths still produce the same AlongRoutePoi *shape* — same field
    // set per result — even though the underlying places differ.
    expect(Object.keys(filterResult.current.results[0]).sort()).toEqual(
      Object.keys(categoryResult.current.results[0]).sort(),
    );
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
    // Unchanged places are projected only once; each fix just refilters them.
    expect(counters.snaps).toBe(places.length);
  });

  it("updates ahead filtering and detour time without resnapping on speed changes", () => {
    const { result } = renderHook(() => useRouteSearch({ category: "fuel" }));
    const initial = result.current.results.find((r) => r.place.id === "b");
    if (!initial) throw new Error("missing initial POI");
    act(() => publishProgress(150));
    expect(result.current.results.map((r) => r.place.id)).toEqual(["b", "c"]);
    const slower = result.current.results.find((r) => r.place.id === "b");
    if (!slower) throw new Error("missing updated POI");
    expect(slower.detourSeconds).toBeCloseTo(initial.detourMeters / 12);
    act(() =>
      useNavigationStore.setState((state) => ({
        progress: state.progress ? { ...state.progress, speedMps: 24 } : null,
      })),
    );
    expect(result.current.results[0].detourSeconds).toBeCloseTo(slower.detourSeconds / 2);
    expect(readRouteMatcherCounters().snaps).toBe(places.length);
  });

  it("reprojects a new filter result array including changed coordinates", () => {
    const filter: OverpassFilter = {
      selectors: [{ tags: [{ key: "brand", op: "=", value: "x" }] }],
    };
    filterSearchResult = { data: { results: places }, isLoading: false, isError: false };
    const { result, rerender } = renderHook(() => useRouteSearch({ filter }));
    const initial = result.current.results[0].alongMeters;
    const refreshed = places.map((p) => ({
      ...p,
      coordinates: [p.coordinates[0] + 0.0005, p.coordinates[1]],
    }));
    filterSearchResult = { ...filterSearchResult, data: { results: refreshed } };
    rerender();
    expect(result.current.results[0].alongMeters).toBeGreaterThan(initial);
    expect(readRouteMatcherCounters().snaps).toBe(places.length * 2);
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
