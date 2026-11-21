// @vitest-environment jsdom

import {
  type BoundingBox,
  type CategoryPlace,
  type DataSourceResult,
  type LngLat,
  useDataSourceStore,
} from "@openmapx/core";
import { act, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { nth, renderHookWithQuery } from "@/test";

interface Pending {
  bbox: BoundingBox;
  filters: Record<string, unknown>;
  resolve: (value: { data: DataSourceResult[] }) => void;
  reject: (error: Error) => void;
}

const lookup = vi.hoisted(() => ({
  pending: [] as Pending[],
  sources: [{ id: "fuel" }] as { id: string }[] | undefined,
}));

vi.mock("@openmapx/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@openmapx/core")>();
  return {
    ...actual,
    useDataSources: ({ enabled = true }: { enabled?: boolean } = {}) => ({
      data: enabled && lookup.sources ? { sources: lookup.sources } : undefined,
      isError: false,
    }),
    dataSourceSearchQueryOptions: (
      sourceId: string,
      bbox: BoundingBox,
      filters: Record<string, unknown>,
    ) => ({
      queryKey: ["data-source-search", sourceId, bbox, filters] as const,
      queryFn: () =>
        new Promise((resolve, reject) => {
          lookup.pending.push({ bbox, filters, resolve, reject });
        }),
      gcTime: 300_000,
    }),
  };
});

import { FUEL_LOOKUP_CONCURRENCY, fuelLookupCells, useRouteFuelPrices } from "./useRouteFuelPrices";

/** A point `km` kilometres east of 9°E on 48.005°N, `offMeters` north of it. */
const at = (km: number, offMeters = 0): LngLat => [9 + km / 74.4, 48.005 + offMeters / 111_320];
const stop = (id: string, km: number, brand?: string): CategoryPlace => ({
  id,
  name: id,
  coordinates: at(km),
  ...(brand ? { brand: { name: brand } } : {}),
});
const station = (
  id: string,
  coordinates: LngLat,
  prices: Record<string, number> = { diesel: 1.559 },
): DataSourceResult => ({
  id,
  name: id,
  coordinates,
  source: "tankerkoenig",
  variant: "open",
  labelSummary: { $t: "summary.priceAge", values: { label: "D" } },
  ...(Object.keys(prices).length > 0 ? { sortValues: prices } : {}),
  contributors: [{ sourceId: "tankerkoenig", name: "Tankerkönig" }],
});
const answer = async (index: number, data: DataSourceResult[]) => {
  await act(async () => nth(lookup.pending, index).resolve({ data }));
};

beforeEach(() => {
  lookup.pending = [];
  lookup.sources = [{ id: "fuel" }];
  useDataSourceStore.getState().setActiveSource(null);
});

describe("fuelLookupCells", () => {
  it("groups nearby stops into one padded grid box, in stop order", () => {
    const cells = fuelLookupCells([stop("b", 30), stop("a", 0.1), stop("a2", 0.3)]);
    expect(cells.map((cell) => cell.placeIds)).toEqual([["b"], ["a", "a2"]]);
    const first = nth(cells, 1);
    expect(first.bbox.west).toBeLessThan(9);
    expect(first.bbox.east - first.bbox.west).toBeGreaterThan(0.02);
    expect(first.bbox.north - first.bbox.south).toBeLessThan(0.022);
  });
});

describe("useRouteFuelPrices", () => {
  it("asks for nothing and returns null when not enabled", () => {
    const places = [stop("a", 0.1)];
    const { result } = renderHookWithQuery(() => useRouteFuelPrices(places, false));
    expect(result.current).toBeNull();
    expect(lookup.pending).toEqual([]);
  });

  it("asks for nothing and returns null when no fuel source is offered", () => {
    lookup.sources = [{ id: "parking" }];
    const places = [stop("a", 0.1)];
    const { result } = renderHookWithQuery(() => useRouteFuelPrices(places, true));
    expect(result.current).toBeNull();
    expect(lookup.pending).toEqual([]);
  });

  it("prices matched stops and marks the rest unknown", async () => {
    const places = [stop("priced", 0.1), stop("no-grade", 0.5), stop("unmatched", 0.9)];
    const { result } = renderHookWithQuery(() => useRouteFuelPrices(places, true));
    await waitFor(() => expect(lookup.pending).toHaveLength(1));
    expect(result.current?.get("priced")).toEqual({ status: "loading" });
    await answer(0, [station("tk-1", at(0.1, 10)), station("tk-2", at(0.5, 5), { e10: 1.699 })]);
    await waitFor(() => expect(result.current?.get("priced")?.status).toBe("priced"));
    const priced = result.current?.get("priced");
    expect(priced?.status === "priced" && priced.result.id).toBe("tk-1");
    expect(result.current?.get("no-grade")).toEqual({ status: "unknown" });
    expect(result.current?.get("unmatched")).toEqual({ status: "unknown" });
  });

  it("shows no marker anywhere while no answer carries any price", async () => {
    const places = [stop("a", 0.1), stop("b", 30), stop("c", 60)];
    const { result } = renderHookWithQuery(() => useRouteFuelPrices(places, true));
    await waitFor(() => expect(lookup.pending).toHaveLength(2));
    await answer(0, [station("osm-a", at(0.1, 5), {})]);
    await act(async () => nth(lookup.pending, 1).reject(new Error("down")));
    await waitFor(() => expect(lookup.pending).toHaveLength(3));
    await answer(2, []);
    await waitFor(() => expect(result.current?.size).toBe(0));
  });

  it("marks earlier priceless stops unknown once a later answer carries a price", async () => {
    const places = [stop("a", 0.1), stop("b", 30)];
    const { result } = renderHookWithQuery(() => useRouteFuelPrices(places, true));
    await waitFor(() => expect(lookup.pending).toHaveLength(2));
    await answer(0, [station("osm-a", at(0.1, 5), {})]);
    await waitFor(() => expect(result.current?.has("a")).toBe(false));
    expect(result.current?.get("b")).toEqual({ status: "loading" });
    await answer(1, [station("tk-b", at(30, 5))]);
    await waitFor(() => expect(result.current?.get("a")).toEqual({ status: "unknown" }));
    expect(result.current?.get("b")?.status).toBe("priced");
  });

  it("counts a price for another grade as price data, and shows that station unknown", async () => {
    const places = [stop("a", 0.1), stop("b", 0.5)];
    const { result } = renderHookWithQuery(() => useRouteFuelPrices(places, true));
    await waitFor(() => expect(lookup.pending).toHaveLength(1));
    await answer(0, [station("tk-a", at(0.1, 5), { e10: 1.699 })]);
    await waitFor(() => expect(result.current?.get("a")).toEqual({ status: "unknown" }));
    expect(result.current?.get("b")).toEqual({ status: "unknown" });
  });

  it("compares the grade the fuel layer selects", async () => {
    useDataSourceStore.getState().setActiveSource("fuel");
    useDataSourceStore.getState().setFilter("fuelType", ["e10", "e5"]);
    const places = [stop("a", 0.1)];
    const { result } = renderHookWithQuery(() => useRouteFuelPrices(places, true));
    await waitFor(() => expect(lookup.pending).toHaveLength(1));
    expect(nth(lookup.pending, 0).filters).toEqual({ fuelType: ["e10", "e5"] });
    await answer(0, [station("tk", at(0.1, 5), { diesel: 1.5, e10: 1.7 })]);
    await waitFor(() => expect(result.current?.get("a")?.status).toBe("priced"));
  });

  it("ignores a fuel-type filter left from another layer", async () => {
    useDataSourceStore.getState().setActiveSource("parking");
    useDataSourceStore.getState().setFilter("fuelType", ["e10"]);
    renderHookWithQuery(() => useRouteFuelPrices([stop("a", 0.1)], true));
    await waitFor(() => expect(lookup.pending).toHaveLength(1));
    expect(nth(lookup.pending, 0).filters).toEqual({});
  });

  it("marks stops unknown when their lookup fails, and keeps the others", async () => {
    const places = [stop("a", 0.1), stop("b", 30)];
    const { result } = renderHookWithQuery(() => useRouteFuelPrices(places, true));
    await waitFor(() => expect(lookup.pending).toHaveLength(2));
    await act(async () => nth(lookup.pending, 0).reject(new Error("down")));
    await answer(1, [station("tk-b", at(30, 5))]);
    await waitFor(() => expect(result.current?.get("a")).toEqual({ status: "unknown" }));
    expect(result.current?.get("b")?.status).toBe("priced");
  });

  it("keeps at most two lookups in flight, in stop order", async () => {
    const places = [0, 5, 10, 15].map((km) => stop(`s${km}`, km + 0.1));
    renderHookWithQuery(() => useRouteFuelPrices(places, true));
    await waitFor(() => expect(lookup.pending).toHaveLength(FUEL_LOOKUP_CONCURRENCY));
    await act(async () => {});
    expect(lookup.pending).toHaveLength(2);
    expect(nth(lookup.pending, 0).bbox.west).toBeLessThan(nth(lookup.pending, 1).bbox.west);
    await answer(0, []);
    await waitFor(() => expect(lookup.pending).toHaveLength(3));
    await answer(1, []);
    await answer(2, []);
    await waitFor(() => expect(lookup.pending).toHaveLength(4));
  });

  it("opens no third lookup when a nearer stop arrives while two are in flight", async () => {
    const late = [stop("s10", 10.1), stop("s15", 15.1)];
    const { rerender } = renderHookWithQuery(
      ({ places }: { places: CategoryPlace[] }) => useRouteFuelPrices(places, true),
      { initialProps: { places: late } },
    );
    await waitFor(() => expect(lookup.pending).toHaveLength(2));
    rerender({ places: [stop("s0", 0.1), ...late] });
    await act(async () => {});
    expect(lookup.pending).toHaveLength(2);
    await answer(0, []);
    await waitFor(() => expect(lookup.pending).toHaveLength(3));
    expect(nth(lookup.pending, 2).bbox.west).toBeLessThan(9);
  });

  it("does not ask again for cells it has answered when the view re-renders or remounts", async () => {
    const places = [stop("a", 0.1), stop("b", 30)];
    const first = renderHookWithQuery(() => useRouteFuelPrices(places, true));
    await waitFor(() => expect(lookup.pending).toHaveLength(2));
    await answer(0, []);
    await answer(1, []);
    first.rerender();
    first.unmount();
    renderHookWithQuery(() => useRouteFuelPrices(places, true), {
      queryClient: first.queryClient,
    });
    await act(async () => {});
    expect(lookup.pending).toHaveLength(2);
  });

  it("asks again for stale cells two at a time when the view is opened again", async () => {
    const places = [0, 5, 10].map((km) => stop(`s${km}`, km + 0.1));
    const first = renderHookWithQuery(() => useRouteFuelPrices(places, true));
    await waitFor(() => expect(lookup.pending).toHaveLength(2));
    await answer(0, []);
    await answer(1, []);
    await waitFor(() => expect(lookup.pending).toHaveLength(3));
    await answer(2, []);
    first.unmount();
    await first.queryClient.invalidateQueries();
    renderHookWithQuery(() => useRouteFuelPrices(places, true), {
      queryClient: first.queryClient,
    });
    await waitFor(() => expect(lookup.pending).toHaveLength(5));
    await act(async () => {});
    expect(lookup.pending).toHaveLength(5);
  });
});
