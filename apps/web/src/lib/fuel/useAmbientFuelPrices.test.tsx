// @vitest-environment jsdom

import type { DataSourceResult } from "@openmapx/core";
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const useDataSourceSearchSpy = vi.fn();

vi.mock("@openmapx/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@openmapx/core")>();
  return {
    ...actual,
    useDataSourceSearch: (...args: unknown[]) => useDataSourceSearchSpy(...args),
  };
});

import { calculateMedian, useAmbientFuelPrices } from "./useAmbientFuelPrices";

function station(
  id: string,
  source: string,
  sortValues: Record<string, number>,
  observedAt = "2026-09-03T10:00:00Z",
): DataSourceResult {
  return {
    id,
    name: id,
    coordinates: [2.35, 48.86],
    source,
    variant: "unknown",
    sortValues,
    observedAt,
    currency: "EUR",
  };
}

function searchResult(data: DataSourceResult[]) {
  return {
    data,
    isLoading: false,
    isError: false,
    attributions: [
      {
        sourceId: "fr-prixcarburants",
        name: "prix-carburants.gouv.fr",
        url: "https://www.prix-carburants.gouv.fr/",
      },
    ],
    freshness: {
      dataAsOf: "2026-09-03T11:00:00Z",
      fetchedAt: "2026-09-03T12:00:00Z",
      hasRealtimeData: false,
      isStale: false,
    },
  };
}

describe("calculateMedian", () => {
  it("calculates odd and even medians without mutating the input", () => {
    const values = [3, 1, 2, 4];
    expect(calculateMedian(values)).toBe(2.5);
    expect(values).toEqual([3, 1, 2, 4]);
    expect(calculateMedian([3, 1, 2])).toBe(2);
    expect(calculateMedian([])).toBeNull();
  });
});

describe("useAmbientFuelPrices", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useDataSourceSearchSpy.mockReturnValue(searchResult([]));
  });

  it("samples one consistent petrol grade and keeps separate sample counts", () => {
    useDataSourceSearchSpy.mockReturnValue(
      searchResult([
        station("one", "fr-prixcarburants", { e10: 1.7, diesel: 1.6 }),
        station("two", "fr-prixcarburants", { e5: 1.9, diesel: 1.8 }),
        station("three", "fr-prixcarburants", { e10: 1.8 }),
      ]),
    );

    const { result } = renderHook(() => useAmbientFuelPrices([2.35, 48.86], true));

    expect(result.current.prices?.petrol).toMatchObject({
      fuelGrade: "e10",
      pricePerLiter: 1.75,
      sampleCount: 2,
      currency: "EUR",
    });
    expect(result.current.prices?.diesel).toMatchObject({
      fuelGrade: "diesel",
      pricePerLiter: 1.7,
      sampleCount: 2,
      currency: "EUR",
    });
  });

  it("falls back to E5 only when no station reports E10", () => {
    useDataSourceSearchSpy.mockReturnValue(
      searchResult([
        station("one", "fr-prixcarburants", { e5: 1.7 }),
        station("two", "fr-prixcarburants", { e5: 1.9, sp98: 2.1 }),
      ]),
    );

    const { result } = renderHook(() => useAmbientFuelPrices([2.35, 48.86], true));

    expect(result.current.prices?.petrol?.fuelGrade).toBe("e5");
    expect(result.current.prices?.petrol?.pricePerLiter).toBe(1.8);
  });

  it("uses actual attribution and upstream freshness in quote provenance", () => {
    useDataSourceSearchSpy.mockReturnValue(
      searchResult([station("one", "fr-prixcarburants", { e10: 1.7 })]),
    );

    const { result } = renderHook(() => useAmbientFuelPrices([2.35, 48.86], true));

    expect(result.current.prices?.petrol?.provenance).toMatchObject({
      kind: "provider",
      timestamp: "2026-09-03T11:00:00Z",
      citation: "prix-carburants.gouv.fr",
    });
  });

  it("uses the oldest included observation when no aggregate data time exists", () => {
    useDataSourceSearchSpy.mockReturnValue({
      data: [
        station("one", "fr-prixcarburants", { e10: 1.7 }, "2026-09-03T10:00:00Z"),
        station("two", "fr-prixcarburants", { e10: 1.8 }, "2026-09-03T08:00:00Z"),
      ],
      isLoading: false,
      isError: false,
      attributions: [
        {
          sourceId: "fr-prixcarburants",
          name: "prix-carburants.gouv.fr",
          url: "https://www.prix-carburants.gouv.fr/",
        },
      ],
      freshness: {
        fetchedAt: "2026-09-03T12:00:00Z",
        hasRealtimeData: false,
        isStale: false,
      },
    });

    const { result } = renderHook(() => useAmbientFuelPrices([2.35, 48.86], true));

    expect(result.current.prices?.petrol?.provenance.timestamp).toBe("2026-09-03T08:00:00Z");
  });

  it("requests priced data without triggering the OSM fallback", () => {
    renderHook(() => useAmbientFuelPrices([2.35, 48.86], true));

    expect(useDataSourceSearchSpy).toHaveBeenCalledWith(
      "fuel",
      expect.objectContaining({ north: expect.any(Number), east: expect.any(Number) }),
      { pricesOnly: true },
    );
  });

  it("does not query or return prices while disabled", () => {
    const { result } = renderHook(() => useAmbientFuelPrices([2.35, 48.86], false));

    expect(useDataSourceSearchSpy).toHaveBeenCalledWith(null, null, { pricesOnly: true });
    expect(result.current.prices).toBeNull();
  });
});
