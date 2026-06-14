import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiClient } from "../../api/client";
import { API_ENDPOINTS } from "../../api/endpoints";
import { createQueryWrapper } from "../../test/queryWrapper";
import { useIsSaved, useLabeledPlaces, useSavedListPlaces, useSavedLists } from "../useSavedPlaces";

describe("useSavedPlaces", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("useSavedLists unwraps the lists field", async () => {
    const lists = [{ id: "l1", name: "Favourites" }];
    const spy = vi.spyOn(apiClient, "get").mockResolvedValue({ lists } as never);

    const { result } = renderHook(() => useSavedLists(), { wrapper: createQueryWrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(lists);
    expect(spy).toHaveBeenCalledWith(API_ENDPOINTS.savedLists);
  });

  it("useLabeledPlaces unwraps the labels field", async () => {
    const labels = [{ label: "home", name: "Home" }];
    const spy = vi.spyOn(apiClient, "get").mockResolvedValue({ labels } as never);

    const { result } = renderHook(() => useLabeledPlaces(), { wrapper: createQueryWrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(labels);
    expect(spy).toHaveBeenCalledWith(API_ENDPOINTS.savedLabels);
  });

  it("useSavedListPlaces fetches places for a list and unwraps them", async () => {
    const places = [{ id: "p1", name: "Cafe" }];
    const spy = vi.spyOn(apiClient, "get").mockResolvedValue({ places } as never);

    const { result } = renderHook(() => useSavedListPlaces("l1"), {
      wrapper: createQueryWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(places);
    expect(spy).toHaveBeenCalledWith(`${API_ENDPOINTS.savedLists}/l1/places`);
  });

  it("useSavedListPlaces stays idle when no list id is given", () => {
    const spy = vi.spyOn(apiClient, "get").mockResolvedValue({ places: [] } as never);

    const { result } = renderHook(() => useSavedListPlaces(null), {
      wrapper: createQueryWrapper(),
    });

    expect(result.current.fetchStatus).toBe("idle");
    expect(spy).not.toHaveBeenCalled();
  });

  it("useIsSaved fetches the matching list ids for a place", async () => {
    const spy = vi.spyOn(apiClient, "get").mockResolvedValue({ listIds: ["l1", "l2"] } as never);

    const { result } = renderHook(() => useIsSaved("p1"), { wrapper: createQueryWrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(["l1", "l2"]);
    expect(spy).toHaveBeenCalledWith(API_ENDPOINTS.savedCheck, { placeId: "p1" });
  });

  it("useIsSaved stays idle when no place id is given", () => {
    const spy = vi.spyOn(apiClient, "get").mockResolvedValue({ listIds: [] } as never);

    const { result } = renderHook(() => useIsSaved(null), { wrapper: createQueryWrapper() });

    expect(result.current.fetchStatus).toBe("idle");
    expect(spy).not.toHaveBeenCalled();
  });
});
