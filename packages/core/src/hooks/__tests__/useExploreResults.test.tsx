import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiClientError, apiClient } from "../../api/client";
import { API_ENDPOINTS } from "../../api/endpoints";
import { useCategoryFacetStore } from "../../stores/categoryFacetStore";
import { useCategorySearchStore } from "../../stores/categorySearchStore";
import { useOpeningHoursStore } from "../../stores/openingHoursStore";
import { createQueryWrapper } from "../../test/queryWrapper";
import { useExploreResults } from "../useExploreResults";

const bbox = { west: 13.3, south: 52.4, east: 13.5, north: 52.6 };
const filter = { selectors: [{ tags: [{ key: "amenity", op: "=" as const, value: "cafe" }] }] };
const success = { results: [], partial: false };
const areaError = new ApiClientError(422, { error: "area_too_large" }, null);

describe("useExploreResults retry", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useCategorySearchStore.getState().clearCategory();
    useCategoryFacetStore.getState().reset();
    useOpeningHoursStore.getState().reset();
  });

  it("exposes an ordinary category failure, then retries the same category and bounds", async () => {
    useCategorySearchStore.getState().setActiveCategory("restaurants");
    useCategorySearchStore.getState().setSearchBbox(bbox);
    const get = vi
      .spyOn(apiClient, "get")
      .mockRejectedValueOnce(new Error("offline"))
      .mockRejectedValueOnce(new Error("offline"))
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(success);
    const post = vi.spyOn(apiClient, "post");

    const { result } = renderHook(() => useExploreResults(), { wrapper: createQueryWrapper() });
    await waitFor(() => expect(result.current.isError).toBe(true), { timeout: 5_000 });
    await act(async () => {
      await result.current.refetch();
    });

    await waitFor(() => expect(result.current.filtered).toEqual([]));
    expect(get).toHaveBeenCalledTimes(4);
    expect(get).toHaveBeenNthCalledWith(
      4,
      API_ENDPOINTS.categorySearch,
      expect.objectContaining({ category: "restaurants", west: "13.3", east: "13.5" }),
      expect.anything(),
    );
    expect(post).not.toHaveBeenCalled();
    expect(useCategorySearchStore.getState().searchBbox).toEqual(bbox);
  }, 10_000);

  it("exposes an ordinary ad-hoc failure, then retries without activating a catalog category", async () => {
    useCategorySearchStore.getState().setAdHocFilter(filter, "Cafes");
    useCategorySearchStore.getState().setSearchBbox(bbox);
    const post = vi
      .spyOn(apiClient, "post")
      .mockRejectedValueOnce(new Error("offline"))
      .mockRejectedValueOnce(new Error("offline"))
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(success);
    const get = vi.spyOn(apiClient, "get");

    const { result } = renderHook(() => useExploreResults(), { wrapper: createQueryWrapper() });
    await waitFor(() => expect(result.current.isError).toBe(true), { timeout: 5_000 });
    await act(async () => {
      await result.current.refetch();
    });

    await waitFor(() => expect(result.current.filtered).toEqual([]));
    expect(post).toHaveBeenCalledTimes(4);
    expect(post).toHaveBeenNthCalledWith(
      4,
      API_ENDPOINTS.poiFilter,
      expect.objectContaining({ filter, west: bbox.west, east: bbox.east }),
      expect.anything(),
    );
    expect(get).not.toHaveBeenCalled();
    expect(useCategorySearchStore.getState().activeCategory).toBe("nlp:filter");
  }, 10_000);

  it("does not automatically retry an oversized category area", async () => {
    useCategorySearchStore.getState().setActiveCategory("restaurants");
    useCategorySearchStore.getState().setSearchBbox(bbox);
    const get = vi.spyOn(apiClient, "get").mockRejectedValue(areaError);

    const { result } = renderHook(() => useExploreResults(), { wrapper: createQueryWrapper() });
    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(get).toHaveBeenCalledTimes(1);
  });

  it("does not automatically retry an oversized ad-hoc area", async () => {
    useCategorySearchStore.getState().setAdHocFilter(filter, "Cafes");
    useCategorySearchStore.getState().setSearchBbox(bbox);
    const post = vi.spyOn(apiClient, "post").mockRejectedValue(areaError);

    const { result } = renderHook(() => useExploreResults(), { wrapper: createQueryWrapper() });
    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(post).toHaveBeenCalledTimes(1);
  });

  it("retries a failed text query without starting category or ad-hoc requests", async () => {
    useCategorySearchStore.getState().setExploreText("coffee shops");
    useCategorySearchStore.getState().setSearchBbox(bbox);
    const get = vi
      .spyOn(apiClient, "get")
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(success);
    const post = vi.spyOn(apiClient, "post");

    const { result } = renderHook(() => useExploreResults(), { wrapper: createQueryWrapper() });
    await waitFor(() => expect(result.current.isError).toBe(true));
    await act(async () => {
      await result.current.refetch();
    });

    await waitFor(() => expect(result.current.filtered).toEqual([]));
    expect(get).toHaveBeenCalledTimes(2);
    expect(get).toHaveBeenNthCalledWith(
      2,
      API_ENDPOINTS.textSearch,
      expect.objectContaining({ q: "coffee shops", west: "13.3", east: "13.5" }),
      expect.anything(),
    );
    expect(post).not.toHaveBeenCalled();
    expect(useCategorySearchStore.getState().mode).toBe("text");
  });
});
