import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const storage = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn(), remove: vi.fn() }));
vi.mock("@/lib/idbStore", () => ({
  idbGet: storage.get,
  idbSet: storage.set,
  idbDelete: storage.remove,
}));
type SessionState = { data: unknown; isPending: boolean; error: unknown };
const signedInU1 = (): SessionState => ({
  data: { user: { id: "u1" }, session: { id: "s1" } },
  isPending: false,
  error: null,
});
const auth = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("@openmapx/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@openmapx/core")>()),
  useSession: () => auth.current,
}));
const { SavedPlacesMirror } = await import("./SavedPlacesMirror");
const { SessionAuthorityBoundary } = await import("@/providers/SessionAuthorityBoundary");

const signedOut = (): SessionState => ({ data: null, isPending: false, error: null });
const signedIn = (userId: string, sessionId: string): SessionState => ({
  data: { user: { id: userId }, session: { id: sessionId } },
  isPending: false,
  error: null,
});
const u1Mirror = () => ({
  userId: "u1",
  lists: [{ id: "u1-list" }],
  labels: [{ id: "u1-home", label: "home" }],
  listPlaces: { "u1-list": [{ id: "u1-place" }] },
});
async function flush() {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
}
function tree(client: QueryClient) {
  return (
    <QueryClientProvider client={client}>
      <SessionAuthorityBoundary>
        <SavedPlacesMirror />
      </SessionAuthorityBoundary>
    </QueryClientProvider>
  );
}
function expectNoSavedData(client: QueryClient) {
  expect(client.getQueryData(["savedLists"])).toBeUndefined();
  expect(client.getQueryData(["labeledPlaces"])).toBeUndefined();
  expect(client.getQueryData(["savedListPlaces", "u1-list"])).toBeUndefined();
}

beforeEach(() => {
  auth.current = signedInU1();
});

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

it("hydrates and persists exact saved/label field receipts including authoritative empty", async () => {
  vi.useFakeTimers();
  const fields = {
    name: [{ sourceId: "old", name: "Original publisher", attributionText: "Original terms" }],
    address: [],
    lat: [],
    lng: [],
  };
  const saved = { id: "saved-1", fieldContributors: fields };
  const label = { id: "label-1", fieldContributors: fields };
  storage.get.mockResolvedValue({
    userId: "u1",
    lists: [{ id: "l1" }],
    labels: [label],
    listPlaces: { l1: [saved] },
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
  expect(client.getQueryData(["savedListPlaces", "l1"])).toEqual([saved]);
  expect(client.getQueryData(["labeledPlaces"])).toEqual([label]);
  await act(async () => {
    client.setQueryData(["savedListPlaces", "l1"], [{ ...saved, note: "My note" }]);
    await vi.advanceTimersByTimeAsync(1000);
  });
  expect(storage.set).toHaveBeenCalledWith(
    "omx-saved-mirror",
    expect.objectContaining({
      listPlaces: { l1: [{ ...saved, note: "My note" }] },
      labels: [label],
    }),
  );
  view.unmount();
  client.clear();
});

describe("saved-data ownership across sessions", () => {
  async function rerender(view: ReturnType<typeof render>, client: QueryClient) {
    act(() => view.rerender(tree(client)));
    await flush();
  }

  it("a sign-out remount drops the mirror instead of re-seeding it", async () => {
    auth.current = signedIn("u1", "s1");
    storage.get.mockResolvedValue(u1Mirror());
    const client = new QueryClient();
    client.setQueryData(["labeledPlaces"], u1Mirror().labels);
    client.setQueryData(["savedLists"], u1Mirror().lists);
    const view = render(tree(client));
    await flush();
    auth.current = signedOut();
    await rerender(view, client);
    expectNoSavedData(client);
    expect(storage.remove).toHaveBeenCalledWith("omx-saved-mirror");
    view.unmount();
    client.clear();
  });

  it("a confirmed signed-out start never seeds a stored mirror", async () => {
    auth.current = signedOut();
    storage.get.mockResolvedValue(u1Mirror());
    const client = new QueryClient();
    const view = render(tree(client));
    await flush();
    expectNoSavedData(client);
    expect(storage.remove).toHaveBeenCalledWith("omx-saved-mirror");
    view.unmount();
    client.clear();
  });

  it("a 401 session answer counts as signed out", async () => {
    auth.current = { data: null, isPending: false, error: { status: 401 } };
    storage.get.mockResolvedValue(u1Mirror());
    const client = new QueryClient();
    const view = render(tree(client));
    await flush();
    expectNoSavedData(client);
    expect(storage.remove).toHaveBeenCalledWith("omx-saved-mirror");
    view.unmount();
    client.clear();
  });

  it("a pending lookup that resolves to signed out clears what it seeded", async () => {
    auth.current = { data: null, isPending: true, error: null };
    storage.get.mockResolvedValue(u1Mirror());
    const client = new QueryClient();
    const view = render(tree(client));
    await flush();
    // A pending lookup is unknown, so the offline copy is shown meanwhile.
    expect(client.getQueryData(["labeledPlaces"])).toEqual(u1Mirror().labels);
    auth.current = signedOut();
    await rerender(view, client);
    expectNoSavedData(client);
    expect(storage.remove).toHaveBeenCalledWith("omx-saved-mirror");
    view.unmount();
    client.clear();
  });

  it.each([
    ["after a sign-out", true],
    ["on a direct account switch", false],
  ])(
    "the next user never sees the previous user's saved data (%s)",
    async (_case, signOutFirst) => {
      auth.current = signedIn("u1", "s1");
      storage.get.mockResolvedValue(u1Mirror());
      const client = new QueryClient();
      client.setQueryData(["labeledPlaces"], u1Mirror().labels);
      client.setQueryData(["savedLists"], u1Mirror().lists);
      const view = render(tree(client));
      await flush();
      if (signOutFirst) {
        auth.current = signedOut();
        await rerender(view, client);
      }
      let finishRead!: (value: unknown) => void;
      storage.get.mockImplementation(
        () =>
          new Promise((resolve) => {
            finishRead = resolve;
          }),
      );
      auth.current = signedIn("u2", "s2");
      await rerender(view, client);
      expectNoSavedData(client);
      await act(async () => {
        finishRead(u1Mirror());
        await Promise.resolve();
      });
      await flush();
      expectNoSavedData(client);
      expect(storage.remove).toHaveBeenCalledWith("omx-saved-mirror");
      view.unmount();
      client.clear();
    },
  );

  it("an unowned stored mirror is not seeded for a signed-in user", async () => {
    auth.current = signedIn("u2", "s2");
    storage.get.mockResolvedValue({ ...u1Mirror(), userId: undefined });
    const client = new QueryClient();
    const view = render(tree(client));
    await flush();
    expectNoSavedData(client);
    expect(storage.remove).toHaveBeenCalledWith("omx-saved-mirror");
    view.unmount();
    client.clear();
  });

  it("an offline start still shows the remembered user's saved places", async () => {
    auth.current = { data: null, isPending: false, error: new TypeError("Failed to fetch") };
    storage.get.mockResolvedValue(u1Mirror());
    const client = new QueryClient();
    const view = render(tree(client));
    await flush();
    expect(client.getQueryData(["labeledPlaces"])).toEqual(u1Mirror().labels);
    expect(client.getQueryData(["savedLists"])).toEqual(u1Mirror().lists);
    expect(storage.remove).not.toHaveBeenCalled();
    view.unmount();
    client.clear();
  });

  it("a server error without a session answer keeps the offline copy", async () => {
    auth.current = { data: null, isPending: false, error: { status: 503 } };
    storage.get.mockResolvedValue(u1Mirror());
    const client = new QueryClient();
    const view = render(tree(client));
    await flush();
    expect(client.getQueryData(["labeledPlaces"])).toEqual(u1Mirror().labels);
    expect(client.getQueryData(["savedLists"])).toEqual(u1Mirror().lists);
    expect(storage.remove).not.toHaveBeenCalled();
    view.unmount();
    client.clear();
  });

  it("the same user signed in again still gets the mirror", async () => {
    auth.current = signedIn("u1", "s1");
    storage.get.mockResolvedValue(u1Mirror());
    const client = new QueryClient();
    const view = render(tree(client));
    await flush();
    expect(client.getQueryData(["labeledPlaces"])).toEqual(u1Mirror().labels);
    expect(client.getQueryData(["savedLists"])).toEqual(u1Mirror().lists);
    expect(client.getQueryData(["savedListPlaces", "u1-list"])).toEqual(
      u1Mirror().listPlaces["u1-list"],
    );
    expect(storage.remove).not.toHaveBeenCalled();
    view.unmount();
    client.clear();
  });
});
