// @vitest-environment jsdom

import { type DataSourceResult, type OverpassFilter, useNavigationStore } from "@openmapx/core";
import type { Route } from "@openmapx/provider-kit/routing";
import { act, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nth, renderHookWithQuery } from "@/test";

vi.mock("next-intl", () => ({ useLocale: () => "en" }));

const fixture = vi.hoisted(() => ({
  places: [
    { id: "a", name: "A", coordinates: [0.001, 0.0002] as [number, number] },
    { id: "b", name: "B", coordinates: [0.003, 0.0001] as [number, number] },
  ],
  fuel: [] as {
    resolve: (value: { data: DataSourceResult[] }) => void;
    reject: (error: Error) => void;
  }[],
}));

vi.mock("@openmapx/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@openmapx/core")>();
  const answer = { data: { results: fixture.places }, isLoading: false, isError: false };
  return {
    ...actual,
    fetchDirections: vi.fn().mockRejectedValue(new Error("offline")),
    useCategorySearch: (category: string | null) =>
      category ? answer : { data: undefined, isLoading: false, isError: false },
    useFilterSearch: (filter: unknown) =>
      filter ? answer : { data: undefined, isLoading: false, isError: false },
    useDataSources: () => ({ data: { sources: [{ id: "fuel" }] }, isError: false }),
    dataSourceSearchQueryOptions: (sourceId: string, bbox: unknown, filters: object) => ({
      queryKey: ["data-source-search", sourceId, bbox, filters] as const,
      queryFn: () =>
        new Promise((resolve, reject) => {
          fixture.fuel.push({ resolve, reject });
        }),
      gcTime: 300_000,
    }),
  };
});

import { useRouteSearch } from "./useRouteSearch";

const route = (): Route =>
  ({
    distance: 444,
    duration: 60,
    geometry: [
      [0, 0],
      [0.002, 0],
      [0.004, 0],
    ],
    legs: [],
    mode: "driving",
    steps: [],
  }) as unknown as Route;

const station = (id: string, coordinates: [number, number]): DataSourceResult => ({
  id,
  name: id,
  coordinates,
  source: "tankerkoenig",
  variant: "open",
  labelSummary: { $t: "summary.priceAge" },
  sortValues: { diesel: 1.559 },
});

beforeEach(() => {
  fixture.fuel = [];
  useNavigationStore.getState().stopNavigation();
  useNavigationStore.getState().startGroundNavigation(route(), "driving", [
    [0, 0],
    [0.004, 0],
  ]);
});

afterEach(() => {
  useNavigationStore.getState().stopNavigation();
});

describe("useRouteSearch fuel prices", () => {
  it("looks up prices for fuel stops ahead", async () => {
    const { result } = renderHookWithQuery(() =>
      useRouteSearch({ category: "preset:amenity/fuel" }),
    );
    await waitFor(() => expect(fixture.fuel).toHaveLength(1));
    expect(result.current.fuelPrices?.get("a")).toEqual({ status: "loading" });
    await act(async () =>
      nth(fixture.fuel, 0).resolve({ data: [station("tk-a", [0.001, 0.0002])] }),
    );
    await waitFor(() => expect(result.current.fuelPrices?.get("a")?.status).toBe("priced"));
    expect(result.current.fuelPrices?.get("b")).toEqual({ status: "unknown" });
  });

  it("makes no fuel lookup for other kinds of stop or a chain", async () => {
    const parking = renderHookWithQuery(() => useRouteSearch({ category: "parking" }));
    const filter: OverpassFilter = {
      selectors: [{ tags: [{ key: "brand:wikidata", op: "=", value: "Q1" }] }],
    };
    const chain = renderHookWithQuery(() => useRouteSearch({ filter }));
    await act(async () => {});
    expect(parking.result.current.results).toHaveLength(2);
    expect(chain.result.current.results).toHaveLength(2);
    expect(fixture.fuel).toEqual([]);
    expect(parking.result.current.fuelPrices).toBeNull();
    expect(chain.result.current.fuelPrices).toBeNull();
  });

  it("keeps its results when the price lookup fails", async () => {
    const { result } = renderHookWithQuery(() =>
      useRouteSearch({ category: "preset:amenity/fuel" }),
    );
    await waitFor(() => expect(fixture.fuel).toHaveLength(1));
    await act(async () => nth(fixture.fuel, 0).reject(new Error("fuel_unavailable")));
    // No answer carried a price, so the failed stops get no marker rather than "unknown".
    await waitFor(() => expect(result.current.fuelPrices?.has("a")).toBe(false));
    expect(result.current.results.map((r) => r.place.id)).toEqual(["a", "b"]);
    expect(result.current.isError).toBe(false);
  });

  it("does not ask again as the position moves", async () => {
    renderHookWithQuery(() => useRouteSearch({ category: "preset:amenity/fuel" }));
    await waitFor(() => expect(fixture.fuel).toHaveLength(1));
    await act(async () => nth(fixture.fuel, 0).resolve({ data: [] }));
    for (const along of [10, 20, 30]) {
      act(() =>
        useNavigationStore.getState().applyProgress({
          snapped: [along / 111_000, 0],
          alongMeters: along,
          deviationMeters: 0,
          segmentIndex: 0,
          etaEpochMs: Date.now() + 60_000,
          bearing: 90,
          speedMps: 12,
        } as never),
      );
    }
    await act(async () => {});
    expect(fixture.fuel).toHaveLength(1);
  });
});
