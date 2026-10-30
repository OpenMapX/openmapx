import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createQueryWrapper, createTestQueryClient } from "../../test/queryWrapper";

const session = vi.hoisted(() => ({ value: null as { user: { id: string } } | null }));
vi.mock("../../auth/useSession", () => ({ useSession: () => ({ data: session.value }) }));

import {
  useDeleteList,
  useImportPlaces,
  useIsSaved,
  useLabeledPlaces,
  useSavedListPlaces,
  useSavedLists,
} from "../useSavedPlaces";

const list = (id = "l1") => ({
  id,
  name: "Trip",
  icon: null,
  isPrivate: true,
  sortOrder: 0,
  placeCount: 0,
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-01T00:00:00Z",
});
const place = {
  id: "p1",
  listId: "l1",
  name: "Cafe",
  address: null,
  lat: 52,
  lng: 13,
  placeId: null,
  note: null,
  sortOrder: 0,
  createdAt: "2026-10-01T00:00:00Z",
};
function respond(handler: (url: URL, init: RequestInit) => unknown | Promise<unknown>) {
  const fetch = vi.fn(async (input: string, init: RequestInit) =>
    Response.json(await handler(new URL(input), init)),
  );
  vi.stubGlobal("fetch", fetch);
  return fetch;
}
beforeEach(() => {
  vi.restoreAllMocks();
  session.value = { user: { id: "u1" } };
});
afterEach(() => vi.unstubAllGlobals());
describe("saved query acquisition", () => {
  it("imports places and invalidates lists, target places and membership", async () => {
    const response = { listId: "l1", name: "Trip", imported: 1, skippedDuplicates: 0 };
    let wire: unknown;
    respond((url, init) => {
      expect(url.pathname).toBe("/api/saved/lists/import");
      expect(init.method).toBe("POST");
      wire = JSON.parse(String(init.body));
      return response;
    });
    const client = createTestQueryClient();
    for (const key of [["savedLists"], ["savedListPlaces", "l1"], ["savedCheck", "p1"]])
      client.setQueryData(key, []);
    const { result, unmount } = renderHook(() => useImportPlaces(), {
      wrapper: createQueryWrapper(client),
    });
    const payload = { target: { name: "Trip" }, places: [{ name: "Cafe", lat: 52, lng: 13 }] };
    try {
      await act(async () => {
        expect(await result.current.mutateAsync(payload)).toEqual(response);
      });
      expect(wire).toEqual(payload);
      for (const key of [["savedLists"], ["savedListPlaces", "l1"], ["savedCheck", "p1"]])
        expect(client.getQueryState(key)?.isInvalidated).toBe(true);
    } finally {
      unmount();
      client.clear();
    }
  });
  it("cannot accept an initial membership response captured before list deletion", async () => {
    let finishRead!: (value: unknown) => void;
    const oldRead = new Promise((resolve) => {
      finishRead = resolve;
    });
    let reads = 0;
    respond(async (_url, init) =>
      init.method === "DELETE" ? { ok: true } : ++reads === 1 ? await oldRead : { listIds: [] },
    );
    const client = createTestQueryClient();
    const { result, unmount } = renderHook(
      () => ({ membership: useIsSaved("p1"), remove: useDeleteList() }),
      { wrapper: createQueryWrapper(client) },
    );
    try {
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
    } finally {
      finishRead({ listIds: [] });
      unmount();
      client.clear();
    }
  });
  it.each([{ remaining: [] }, { remaining: ["l2"] }])(
    "refreshes membership to $remaining after deleting its list",
    async ({ remaining }) => {
      let deleted = false;
      respond((url, init) => {
        if (init.method === "DELETE") {
          deleted = true;
          return { ok: true };
        }
        if (url.pathname === "/api/saved/lists")
          return { lists: (deleted ? remaining : ["l1", ...remaining]).map((id) => list(id)) };
        if (url.pathname === "/api/saved/check")
          return { listIds: deleted ? remaining : ["l1", ...remaining] };
        throw new Error("Unexpected saved request");
      });
      const client = createTestQueryClient();
      client.setQueryDefaults(["savedListPlaces"], { gcTime: Infinity });
      client.setQueryData(["savedListPlaces", "l1"], [{ id: "deleted-place" }]);
      client.setQueryData(["savedListPlaces", "l2"], [{ id: "retained-place" }]);
      const { result, unmount } = renderHook(
        () => ({ lists: useSavedLists(), membership: useIsSaved("p1"), remove: useDeleteList() }),
        { wrapper: createQueryWrapper(client) },
      );
      try {
        await waitFor(() => expect(result.current.membership.data).toEqual(["l1", ...remaining]));
        await act(async () => {
          await result.current.remove.mutateAsync("l1");
        });
        await waitFor(() =>
          expect(result.current.lists.data).toEqual(remaining.map((id) => list(id))),
        );
        await waitFor(() => expect(result.current.membership.data).toEqual(remaining));
        expect(client.getQueryData(["savedListPlaces", "l1"])).toBeUndefined();
        expect(client.getQueryData(["savedListPlaces", "l2"])).toEqual([{ id: "retained-place" }]);
      } finally {
        unmount();
        client.clear();
      }
    },
  );
  it("fetches nothing for a signed-out visitor", () => {
    session.value = null;
    const fetch = respond(() => {
      throw new Error("Unexpected acquisition");
    });
    const wrapper = createQueryWrapper();
    const hooks = [
      renderHook(() => useSavedLists(), { wrapper }),
      renderHook(() => useLabeledPlaces(), { wrapper }),
      renderHook(() => useSavedListPlaces("l1"), { wrapper }),
      renderHook(() => useIsSaved("p1"), { wrapper }),
    ];
    try {
      for (const { result } of hooks) expect(result.current.fetchStatus).toBe("idle");
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      for (const hook of hooks) hook.unmount();
    }
  });
  it("reads validated lists, labels, places and membership through generated paths", async () => {
    const label = {
      id: "label",
      label: "home",
      name: "Home",
      icon: null,
      address: null,
      lat: 52,
      lng: 13,
      placeId: null,
    };
    respond((url) => {
      if (url.pathname === "/api/saved/lists") return { lists: [list()] };
      if (url.pathname === "/api/saved/labels") return { labels: [label] };
      if (url.pathname.endsWith("/places")) {
        expect(url.pathname).toBe("/api/saved/lists/l%2F1/places");
        return { places: [place] };
      }
      expect(url.searchParams.get("placeId")).toBe("osm:node:1");
      return { listIds: ["l1", "l2"] };
    });
    const client = createTestQueryClient();
    const wrapper = createQueryWrapper(client);
    const { result, unmount } = renderHook(
      () => ({
        lists: useSavedLists(),
        labels: useLabeledPlaces(),
        places: useSavedListPlaces("l/1"),
        saved: useIsSaved("osm:node:1"),
      }),
      { wrapper },
    );
    try {
      await waitFor(() =>
        expect(
          result.current.saved.isSuccess &&
            result.current.places.isSuccess &&
            result.current.labels.isSuccess &&
            result.current.lists.isSuccess,
        ).toBe(true),
      );
      expect(result.current.lists.data).toEqual([list()]);
      expect(result.current.labels.data).toEqual([label]);
      expect(result.current.places.data).toEqual([place]);
      expect(result.current.saved.data).toEqual(["l1", "l2"]);
    } finally {
      unmount();
      client.clear();
    }
  });
  it("leaves missing list/place identities disabled", () => {
    const fetch = respond(() => {
      throw new Error("Unexpected acquisition");
    });
    const wrapper = createQueryWrapper();
    const places = renderHook(() => useSavedListPlaces(null), { wrapper });
    const saved = renderHook(() => useIsSaved(null), { wrapper });
    try {
      expect(places.result.current.fetchStatus).toBe("idle");
      expect(saved.result.current.fetchStatus).toBe("idle");
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      places.unmount();
      saved.unmount();
    }
  });
  it("rejects malformed saved HTTP successes before query-cache publication", async () => {
    respond(() => ({ lists: [{ id: "l1" }] }));
    const client = createTestQueryClient();
    const { result, unmount } = renderHook(() => useSavedLists(), {
      wrapper: createQueryWrapper(client),
    });
    try {
      await waitFor(() => expect(result.current.isError).toBe(true));
      expect(client.getQueryData(["savedLists"])).toBeUndefined();
    } finally {
      unmount();
      client.clear();
    }
  });
});
