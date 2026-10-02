import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const storage = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn(), remove: vi.fn() }));
vi.mock("@/lib/idbStore", () => ({
  idbGet: storage.get,
  idbSet: storage.set,
  idbDelete: storage.remove,
}));
vi.mock("@openmapx/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@openmapx/core")>()),
  useSession: () => ({ data: { user: { id: "u1" } } }),
}));
const { SavedPlacesMirror } = await import("./SavedPlacesMirror");

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("saved-list mirror cleanup", () => {
  it.each([false, true])(
    "retains new-list places before refreshed metadata (during hydration: %s)",
    async (duringHydration) => {
      vi.useFakeTimers();
      const stored = {
        userId: "u1",
        lists: [{ id: "l1" }],
        listPlaces: { l1: [{ id: "p1" }] },
      };
      let finishRead!: (value: unknown) => void;
      if (duringHydration)
        storage.get.mockImplementation(
          () =>
            new Promise((resolve) => {
              finishRead = resolve;
            }),
        );
      else storage.get.mockResolvedValue(stored);
      const client = new QueryClient();
      client.setQueryData(["savedLists"], stored.lists);
      const view = render(
        <QueryClientProvider client={client}>
          <SavedPlacesMirror />
        </QueryClientProvider>,
      );
      await act(async () => {
        await Promise.resolve();
      });
      await act(async () => {
        client.setQueryData(["savedListPlaces", "l2"], [{ id: "new-p2" }]);
        await client.invalidateQueries({ queryKey: ["savedLists"] });
        if (duringHydration) {
          finishRead(stored);
          await Promise.resolve();
        }
        client.setQueryData(["savedLists"], [{ id: "l1" }, { id: "l2" }]);
        await vi.advanceTimersByTimeAsync(1000);
      });
      expect(storage.set).toHaveBeenCalledWith(
        "omx-saved-mirror",
        expect.objectContaining({ listPlaces: { l1: [{ id: "p1" }], l2: [{ id: "new-p2" }] } }),
      );
      view.unmount();
      client.clear();
    },
  );

  it.each([false, true])(
    "prefers current cache to a delayed stored snapshot (update during hydration: %s)",
    async (duringHydration) => {
      vi.useFakeTimers();
      let finishRead!: (value: unknown) => void;
      storage.get.mockImplementation(
        () =>
          new Promise((resolve) => {
            finishRead = resolve;
          }),
      );
      const client = new QueryClient();
      const publishCurrent = () => {
        client.setQueryData(["savedLists"], [{ id: "l2" }]);
        client.setQueryData(["savedListPlaces", "l2"], [{ id: "fresh-p2" }]);
        client.setQueryData(["labeledPlaces"], [{ id: "fresh-label" }]);
      };
      if (!duringHydration) publishCurrent();
      const view = render(
        <QueryClientProvider client={client}>
          <SavedPlacesMirror />
        </QueryClientProvider>,
      );
      if (duringHydration) act(publishCurrent);
      await act(async () => {
        finishRead({
          userId: "u1",
          lists: [{ id: "l1" }, { id: "l2" }],
          labels: [{ id: "old-label" }],
          listPlaces: { l1: [{ id: "deleted-p1" }], l2: [{ id: "old-p2" }] },
        });
        await Promise.resolve();
      });
      expect(client.getQueryData(["savedListPlaces", "l1"])).toBeUndefined();
      expect(client.getQueryData(["savedListPlaces", "l2"])).toEqual([{ id: "fresh-p2" }]);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      expect(storage.set).toHaveBeenCalledWith(
        "omx-saved-mirror",
        expect.objectContaining({
          lists: [{ id: "l2" }],
          labels: [{ id: "fresh-label" }],
          listPlaces: { l2: [{ id: "fresh-p2" }] },
        }),
      );
      view.unmount();
      client.clear();
    },
  );

  it("retains offline places when a still-existing list's query is evicted", async () => {
    vi.useFakeTimers();
    storage.get.mockResolvedValue({
      userId: "u1",
      lists: [{ id: "l1" }],
      listPlaces: { l1: [{ id: "p1" }] },
    });
    const client = new QueryClient();
    const view = render(
      <QueryClientProvider client={client}>
        <SavedPlacesMirror />
      </QueryClientProvider>,
    );
    await act(async () => {
      await Promise.resolve();
    });
    act(() => {
      client.removeQueries({ queryKey: ["savedListPlaces", "l1"], exact: true });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(storage.set).toHaveBeenCalledWith(
      "omx-saved-mirror",
      expect.objectContaining({ lists: [{ id: "l1" }], listPlaces: { l1: [{ id: "p1" }] } }),
    );
    view.unmount();
    client.clear();
  });

  it("drops deleted-list places from the mirror while retaining another list and ignoring late results", async () => {
    vi.useFakeTimers();
    storage.get.mockResolvedValue({
      userId: "u1",
      lists: [{ id: "l1" }, { id: "l2" }],
      listPlaces: { l1: [{ id: "p1" }], l2: [{ id: "p2" }] },
    });
    const client = new QueryClient();
    const view = render(
      <QueryClientProvider client={client}>
        <SavedPlacesMirror />
      </QueryClientProvider>,
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(client.getQueryData(["savedListPlaces", "l2"])).toEqual([{ id: "p2" }]);
    act(() => {
      client.setQueryData(["savedLists"], [{ id: "l2" }]);
      client.removeQueries({ queryKey: ["savedListPlaces", "l1"], exact: true });
      // An old query finishing after the list refresh cannot revive its mirror.
      client.setQueryData(["savedListPlaces", "l1"], [{ id: "late-p1" }]);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(storage.set).toHaveBeenCalledWith(
      "omx-saved-mirror",
      expect.objectContaining({ lists: [{ id: "l2" }], listPlaces: { l2: [{ id: "p2" }] } }),
    );
    view.unmount();
    client.clear();
  });
});
