import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiClient } from "../../api/client";
import { API_ENDPOINTS } from "../../api/endpoints";
import { createQueryWrapper, createTestQueryClient } from "../../test/queryWrapper";

const session = vi.hoisted(() => ({ value: null as { user: { id: string } } | null }));
vi.mock("../../auth/useSession", () => ({ useSession: () => ({ data: session.value }) }));

import {
  useDeleteList,
  useIsSaved,
  useLabeledPlaces,
  useSavedListPlaces,
  useSavedLists,
} from "../useSavedPlaces";

describe("useSavedPlaces", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    session.value = { user: { id: "u1" } };
  });

  it("cannot accept an initial membership response captured before list deletion", async () => {
    let finishRead!: (value: { listIds: string[] }) => void;
    const oldRead = new Promise<{ listIds: string[] }>((resolve) => {
      finishRead = resolve;
    });
    let reads = 0;
    vi.spyOn(apiClient, "get").mockImplementation(async () => {
      reads += 1;
      return (reads === 1 ? await oldRead : { listIds: [] }) as never;
    });
    vi.spyOn(apiClient, "delete").mockResolvedValue({ ok: true } as never);
    const client = createTestQueryClient();
    const { result } = renderHook(
      () => ({ membership: useIsSaved("p1"), remove: useDeleteList() }),
      { wrapper: createQueryWrapper(client) },
    );
    await waitFor(() => expect(reads).toBe(1));
    await act(async () => {
      await result.current.remove.mutateAsync("l1");
    });
    await act(async () => {
      finishRead({ listIds: ["l1"] });
      await oldRead;
    });
    await waitFor(() => expect(result.current.membership.data).toEqual([]));
    expect(reads).toBe(2);
    client.clear();
  });

  it.each([{ remaining: [] }, { remaining: ["l2"] }])(
    "refreshes membership to $remaining when its containing list is deleted",
    async ({ remaining }) => {
      let deleted = false;
      vi.spyOn(apiClient, "get").mockImplementation(async (path) => {
        if (path === API_ENDPOINTS.savedLists)
          return {
            lists: deleted
              ? remaining.map((id) => ({ id }))
              : [{ id: "l1" }, ...remaining.map((id) => ({ id }))],
          } as never;
        if (path === API_ENDPOINTS.savedCheck)
          return { listIds: deleted ? remaining : ["l1", ...remaining] } as never;
        throw new Error(`Unexpected request ${path}`);
      });
      vi.spyOn(apiClient, "delete").mockImplementation(async () => {
        deleted = true;
        return { ok: true } as never;
      });
      const client = createTestQueryClient();
      client.setQueryDefaults(["savedListPlaces"], { gcTime: Infinity });
      client.setQueryData(["savedListPlaces", "l1"], [{ id: "deleted-place" }]);
      client.setQueryData(["savedListPlaces", "l2"], [{ id: "retained-place" }]);
      const { result } = renderHook(
        () => ({ lists: useSavedLists(), membership: useIsSaved("p1"), remove: useDeleteList() }),
        { wrapper: createQueryWrapper(client) },
      );
      await waitFor(() => expect(result.current.membership.data).toEqual(["l1", ...remaining]));
      await act(async () => {
        await result.current.remove.mutateAsync("l1");
      });
      await waitFor(() =>
        expect(result.current.lists.data).toEqual(remaining.map((id) => ({ id }))),
      );
      await waitFor(() => expect(result.current.membership.data).toEqual(remaining));
      expect(client.getQueryData(["savedListPlaces", "l1"])).toBeUndefined();
      expect(client.getQueryData(["savedListPlaces", "l2"])).toEqual([{ id: "retained-place" }]);
      client.clear();
    },
  );

  it("fetches nothing for a signed-out visitor", () => {
    session.value = null;
    const spy = vi.spyOn(apiClient, "get").mockResolvedValue({} as never);
    const wrapper = createQueryWrapper();

    const lists = renderHook(() => useSavedLists(), { wrapper });
    const labels = renderHook(() => useLabeledPlaces(), { wrapper });
    const places = renderHook(() => useSavedListPlaces("l1"), { wrapper });
    const saved = renderHook(() => useIsSaved("p1"), { wrapper });

    for (const { result } of [lists, labels, places, saved]) {
      expect(result.current.fetchStatus).toBe("idle");
    }
    expect(spy).not.toHaveBeenCalled();
  });

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
