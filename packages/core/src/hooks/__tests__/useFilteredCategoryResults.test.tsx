import type { CategoryPlace } from "@integrations/poi-search/types";
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiClient } from "../../api/client";
import { useCategorySearchStore } from "../../stores/categorySearchStore";
import { useOpeningHoursStore } from "../../stores/openingHoursStore";
import { createQueryWrapper } from "../../test/queryWrapper";
import type { BoundingBox } from "../../types/geometry";
import type { OverpassFilter } from "../../utils/overpassFilter";
import { useFilteredCategoryResults } from "../useFilteredCategoryResults";

const bbox: BoundingBox = { south: 52.4, west: 13.3, north: 52.6, east: 13.5 };

const adHocFilter: OverpassFilter = {
  selectors: [{ tags: [{ key: "amenity", op: "=", value: "pharmacy" }] }],
};

function makePlace(id: string, isOpen: boolean): CategoryPlace {
  return {
    id,
    name: `Place ${id}`,
    coordinates: [13.4, 52.5] as [number, number],
    isOpen,
    openingHoursInfo: { status: { isOpen } },
  } as unknown as CategoryPlace;
}

describe("useFilteredCategoryResults — ad-hoc mode", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useCategorySearchStore.getState().clearCategory();
    useOpeningHoursStore.getState().reset();
  });

  it("in ad-hoc mode: fetches via useFilterSearch (apiClient.post) and returns results", async () => {
    const openPlace = makePlace("osm:node/1", true);
    const response = { results: [openPlace], partial: false };
    vi.spyOn(apiClient, "post").mockResolvedValue(response as never);
    vi.spyOn(apiClient, "get").mockResolvedValue({ results: [], partial: false } as never);

    useCategorySearchStore.setState({ searchBbox: bbox });
    useCategorySearchStore.getState().setAdHocFilter(adHocFilter, "Pharmacies");

    const { result } = renderHook(() => useFilteredCategoryResults(), {
      wrapper: createQueryWrapper(),
    });

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.rawResults).toEqual([openPlace]);
    expect(apiClient.post).toHaveBeenCalled();
  });

  it("in ad-hoc mode with open_now filter: only open places survive, closed are dropped", async () => {
    const openPlace = makePlace("osm:node/1", true);
    const closedPlace = makePlace("osm:node/2", false);
    const response = { results: [openPlace, closedPlace], partial: false };
    vi.spyOn(apiClient, "post").mockResolvedValue(response as never);
    vi.spyOn(apiClient, "get").mockResolvedValue({ results: [], partial: false } as never);

    useOpeningHoursStore.getState().setOpeningHoursFilter("open_now");
    useCategorySearchStore.setState({ searchBbox: bbox });
    useCategorySearchStore.getState().setAdHocFilter(adHocFilter, "Pharmacies open now");

    const { result } = renderHook(() => useFilteredCategoryResults(), {
      wrapper: createQueryWrapper(),
    });

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.filtered).toEqual([openPlace]);
    expect(result.current.filtered).not.toContainEqual(closedPlace);
  });

  it("in ad-hoc mode: facet filters are NOT applied (server already filtered by tag)", async () => {
    const openPlace = makePlace("osm:node/1", true);
    const response = { results: [openPlace], partial: false };
    vi.spyOn(apiClient, "post").mockResolvedValue(response as never);
    vi.spyOn(apiClient, "get").mockResolvedValue({ results: [], partial: false } as never);

    useCategorySearchStore.setState({ searchBbox: bbox });
    useCategorySearchStore.getState().setAdHocFilter(adHocFilter, "Pharmacies");

    const { useCategoryFacetStore } = await import("../../stores/categoryFacetStore");
    useCategoryFacetStore.setState({ selections: { wheelchairAccessible: ["on"] } });

    const { result } = renderHook(() => useFilteredCategoryResults(), {
      wrapper: createQueryWrapper(),
    });

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.filtered).toEqual([openPlace]);
  });

  it("in normal category mode: categorySearch is used, not filterSearch", async () => {
    const place = makePlace("osm:node/99", true);
    const categoryResponse = { results: [place], partial: false };
    const postSpy = vi
      .spyOn(apiClient, "post")
      .mockResolvedValue({ results: [], partial: false } as never);
    vi.spyOn(apiClient, "get").mockResolvedValue(categoryResponse as never);

    useCategorySearchStore.setState({ searchBbox: bbox });
    useCategorySearchStore.getState().setActiveCategory("cafes" as never);

    const { result } = renderHook(() => useFilteredCategoryResults(), {
      wrapper: createQueryWrapper(),
    });

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.rawResults).toEqual([place]);
    expect(postSpy).not.toHaveBeenCalled();
  });
});
