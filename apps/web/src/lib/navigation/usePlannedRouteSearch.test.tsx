// @vitest-environment jsdom

import type { BoundingBox, CategoryPlace, LngLat, OverpassFilter, Route } from "@openmapx/core";
import { act, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHookWithQuery } from "@/test";

interface Pending {
  key: string;
  bbox: BoundingBox;
  resolve: (value: { results: CategoryPlace[]; partial: boolean; truncated?: boolean }) => void;
  reject: (error: Error) => void;
}

const search = vi.hoisted(() => ({
  pending: [] as Pending[],
  calls: [] as string[],
  filterCalls: [] as string[],
}));
const directions = vi.hoisted(() => vi.fn());

vi.mock("@openmapx/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@openmapx/core")>();
  const options = (kind: string, value: string, bbox: BoundingBox, lang?: string) => ({
    queryKey: [kind, value, bbox, lang] as const,
    queryFn: () =>
      new Promise((resolve, reject) => {
        const key = `${kind}:${value}:${bbox.west.toFixed(3)}`;
        (kind === "filter-search" ? search.filterCalls : search.calls).push(key);
        search.pending.push({ key, bbox, resolve, reject });
      }),
    gcTime: 300_000,
    retry: false,
  });
  return {
    ...actual,
    fetchDirections: directions,
    categorySearchQueryOptions: (category: string, bbox: BoundingBox, lang?: string) =>
      options("category-search", category, bbox, lang),
    filterSearchQueryOptions: (filter: OverpassFilter, bbox: BoundingBox, lang?: string) =>
      options("filter-search", JSON.stringify(filter), bbox, lang),
  };
});

import {
  PLANNED_SEARCH_CONCURRENCY,
  usePlannedRouteSearch,
  usePlannedStopDetour,
} from "./usePlannedRouteSearch";

/** Due east along the equator; 1 km ≈ 1/111.32°. */
const KM = 1 / 111.32;
const eastLine = (km: number): LngLat[] =>
  Array.from({ length: km + 1 }, (_, i) => [i * KM, 0] as LngLat);
const place = (id: string, km: number, offMeters = 100): CategoryPlace => ({
  id,
  name: id,
  coordinates: [km * KM, offMeters / 111_320],
});
const settle = async (index: number, results: CategoryPlace[], extra: object = {}) => {
  await act(async () => {
    search.pending[index].resolve({ results, partial: false, ...extra });
  });
};

beforeEach(() => {
  search.pending = [];
  search.calls = [];
  search.filterCalls = [];
  directions.mockReset();
});

describe("usePlannedRouteSearch", () => {
  it("issues no request without a search", () => {
    const geometry = eastLine(60);
    const { result } = renderHookWithQuery(() => usePlannedRouteSearch(geometry, null, "en"));
    expect(search.calls).toEqual([]);
    expect(result.current.results).toEqual([]);
    expect(result.current.isSearching).toBe(false);
  });

  it("keeps at most two areas in flight, in route order", async () => {
    const geometry = eastLine(60);
    const { result } = renderHookWithQuery(() =>
      usePlannedRouteSearch(geometry, { category: "ev_charging" }, "en"),
    );
    await waitFor(() => expect(search.calls).toHaveLength(2));
    expect(result.current).toMatchObject({ totalChunks: 3, settledChunks: 0, isSearching: true });
    expect(search.pending.map((p) => p.bbox.west < 1 * KM)).toEqual([true, false]);
    await settle(0, []);
    await waitFor(() => expect(search.calls).toHaveLength(3));
    expect(search.pending[2].bbox.east).toBeGreaterThan(59 * KM);
  });

  it("merges overlapping areas once each, in route order, within the corridor", async () => {
    const geometry = eastLine(40);
    const { result } = renderHookWithQuery(() =>
      usePlannedRouteSearch(geometry, { category: "preset:amenity/fuel" }, "en"),
    );
    await waitFor(() => expect(search.calls).toHaveLength(2));
    await settle(1, [place("late", 30), place("shared", 25)]);
    await settle(0, [place("shared", 25), place("early", 5), place("far-off", 10, 2000)]);
    await waitFor(() => expect(result.current.isSearching).toBe(false));
    expect(result.current.results.map((r) => r.place.id)).toEqual(["early", "shared", "late"]);
    expect(result.current.results[0].alongMeters).toBeCloseTo(5000, -2);
    expect(result.current).toMatchObject({
      settledChunks: 2,
      failedChunks: 0,
      truncated: false,
      incomplete: false,
      capped: false,
    });
  });

  it("reports how far a very long route was searched", async () => {
    const geometry = eastLine(1200);
    const { result } = renderHookWithQuery(() =>
      usePlannedRouteSearch(geometry, { category: "hotels" }, "en"),
    );
    await waitFor(() => expect(search.calls).toHaveLength(2));
    expect(result.current).toMatchObject({
      capped: true,
      searchedMeters: 1_000_000,
      totalChunks: 40,
    });
  });

  it("does not let a failed area block the rest, and retries only that area", async () => {
    const geometry = eastLine(60);
    const { result } = renderHookWithQuery(() =>
      usePlannedRouteSearch(geometry, { category: "parking" }, "en"),
    );
    await waitFor(() => expect(search.calls).toHaveLength(2));
    await act(async () => search.pending[0].reject(new Error("overpass_unavailable")));
    await waitFor(() => expect(search.calls).toHaveLength(3));
    await settle(1, [place("p", 30)]);
    await settle(2, [], { truncated: true });
    await waitFor(() => expect(result.current.isSearching).toBe(false));
    expect(result.current).toMatchObject({ failedChunks: 1, truncated: true, settledChunks: 3 });
    expect(result.current.results.map((r) => r.place.id)).toEqual(["p"]);
    act(() => result.current.retry());
    await waitFor(() => expect(search.calls).toHaveLength(4));
    expect(search.calls[3]).toBe(search.calls[0]);
  });

  it("does not refetch every cached area at once when the search is shown again", async () => {
    const geometry = eastLine(60);
    const first = renderHookWithQuery(() =>
      usePlannedRouteSearch(geometry, { category: "hotels" }, "en"),
    );
    await waitFor(() => expect(search.calls).toHaveLength(2));
    await settle(0, []);
    await settle(1, []);
    await waitFor(() => expect(search.calls).toHaveLength(3));
    await settle(2, []);
    first.unmount();
    await first.queryClient.invalidateQueries();
    const before = search.calls.length;
    const again = renderHookWithQuery(
      () => usePlannedRouteSearch(geometry, { category: "hotels" }, "en"),
      { queryClient: first.queryClient },
    );
    await act(async () => {});
    expect(search.calls.length - before).toBeLessThanOrEqual(PLANNED_SEARCH_CONCURRENCY);
    expect(again.result.current.isSearching).toBe(false);
  });

  it("retries failed areas two at a time", async () => {
    const geometry = eastLine(60);
    const { result } = renderHookWithQuery(() =>
      usePlannedRouteSearch(geometry, { category: "parking" }, "en"),
    );
    await waitFor(() => expect(search.calls).toHaveLength(2));
    await act(async () => search.pending[0].reject(new Error("down")));
    await act(async () => search.pending[1].reject(new Error("down")));
    await waitFor(() => expect(search.calls).toHaveLength(3));
    await act(async () => search.pending[2].reject(new Error("down")));
    await waitFor(() => expect(result.current.failedChunks).toBe(3));
    act(() => result.current.retry());
    await waitFor(() => expect(search.calls).toHaveLength(5));
    await act(async () => {});
    expect(search.calls).toHaveLength(5);
    await settle(3, []);
    await waitFor(() => expect(search.calls).toHaveLength(6));
    await settle(4, []);
    await settle(5, []);
    await waitFor(() => expect(result.current.failedChunks).toBe(0));
    await waitFor(() => expect(result.current.isSearching).toBe(false), { timeout: 3000 });
    expect(search.calls).toHaveLength(6);
  });

  it("marks a partial area answer as incomplete", async () => {
    const geometry = eastLine(20);
    const { result } = renderHookWithQuery(() =>
      usePlannedRouteSearch(geometry, { category: "cafes" }, "en"),
    );
    await waitFor(() => expect(search.calls).toHaveLength(1));
    await settle(0, [], { partial: true });
    await waitFor(() => expect(result.current.incomplete).toBe(true));
  });

  it("searches a chain with the filter search", async () => {
    const geometry = eastLine(20);
    const filter: OverpassFilter = {
      selectors: [{ tags: [{ key: "brand:wikidata", op: "=", value: "Q1" }] }],
    };
    renderHookWithQuery(() => usePlannedRouteSearch(geometry, { filter }, "en"));
    await waitFor(() => expect(search.filterCalls).toHaveLength(1));
    expect(search.calls).toEqual([]);
  });
});

describe("usePlannedStopDetour", () => {
  const geometry = eastLine(20);
  const waypoints: LngLat[] = [
    [0, 0],
    [10 * KM, 0],
    [20 * KM, 0],
  ];
  const routeOf = (seconds: number) => ({
    routes: [{ distance: seconds * 10, duration: seconds, geometry, legs: [], steps: [] }],
    provider: "valhalla",
  });

  it("compares the stop with the displayed route, requested like it", async () => {
    directions.mockImplementation(async () => routeOf(1180));
    const candidate = { id: "aral", coordinates: [15 * KM, 0.0005] as LngLat };
    const displayed = { ...routeOf(1000).routes[0], mode: "motorcycle" } as unknown as Route;
    const { result } = renderHookWithQuery(() =>
      usePlannedStopDetour({
        route: displayed,
        waypoints,
        candidate,
        provider: "valhalla",
        request: { mode: "motorcycle", avoidHighways: true, avoidTolls: true, lang: "de" },
      }),
    );
    await waitFor(() => expect(result.current.detour?.kind).toBe("network"));
    expect(result.current.detour).toMatchObject({ kind: "network", seconds: 180 });
    const requests = directions.mock.calls.map(([request]) => request as { waypoints: LngLat[] });
    expect(requests.map((r) => r.waypoints)).toEqual([
      [waypoints[0], waypoints[1], candidate.coordinates, waypoints[2]],
    ]);
    expect(requests[0]).toMatchObject({
      mode: "motorcycle",
      avoidHighways: false,
      avoidTolls: false,
      lang: "de",
      provider: "valhalla",
    });
  });

  it("requests a baseline when the displayed route's provider is unknown", async () => {
    directions.mockImplementation(async (request: unknown) =>
      routeOf((request as { waypoints: LngLat[] }).waypoints.length === 3 ? 1000 : 1180),
    );
    const { result } = renderHookWithQuery(() =>
      usePlannedStopDetour({
        route: routeOf(900).routes[0] as unknown as Route,
        waypoints,
        candidate: { id: "aral", coordinates: [15 * KM, 0.0005] },
        request: { mode: "driving", lang: "en" },
      }),
    );
    await waitFor(() => expect(result.current.detour?.kind).toBe("network"));
    expect(directions).toHaveBeenCalledTimes(2);
    expect(result.current.detour).toMatchObject({ seconds: 180 });
  });

  it("does not request anything without a selected stop", () => {
    renderHookWithQuery(() =>
      usePlannedStopDetour({
        route: routeOf(900).routes[0] as unknown as Route,
        waypoints,
        candidate: null,
        request: { mode: "driving", lang: "en" },
      }),
    );
    expect(directions).not.toHaveBeenCalled();
  });
});
