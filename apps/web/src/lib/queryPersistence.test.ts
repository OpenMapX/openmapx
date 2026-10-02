import { QueryClient, QueryObserver } from "@tanstack/react-query";
import type {
  PersistedClient,
  PersistedQueryClientSaveOptions,
} from "@tanstack/react-query-persist-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PERSONAL_TIMELINE_CACHE_BUSTER,
  shouldDehydrateOpenMapXMutation,
} from "./personalTimelineCachePolicy";
import { subscribeRecentMapDataPersistence } from "./queryPersistence";
import {
  clearRecentMapDataCache,
  isRecentMapDataQueryKey,
  RECENT_MAP_DATA_CACHE_ENABLED_KEY,
  setRecentMapDataCacheEnabled,
} from "./recentMapDataCache";

vi.mock("./idbStore", () => ({ idbDelete: vi.fn(async () => {}), idbGet: vi.fn() }));

const cleanups: Array<() => void> = [];
beforeEach(() => {
  vi.useFakeTimers();
  localStorage.setItem(RECENT_MAP_DATA_CACHE_ENABLED_KEY, "true");
});
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  localStorage.clear();
  vi.useRealTimers();
});

function fixture() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } });
  const persistClient = vi.fn();
  const shouldDehydrateQuery = vi.fn();
  const snapshots: PersistedClient[] = [];
  const options = {
    queryClient,
    persister: {
      persistClient: (snapshot: PersistedClient) => {
        persistClient(snapshot);
        snapshots.push(snapshot);
      },
      restoreClient: async () => undefined,
      removeClient: async () => {},
    },
    buster: PERSONAL_TIMELINE_CACHE_BUSTER,
    dehydrateOptions: {
      shouldDehydrateQuery: (query) => {
        shouldDehydrateQuery(query);
        return query.state.status === "success" && isRecentMapDataQueryKey(query.queryKey);
      },
      shouldDehydrateMutation: shouldDehydrateOpenMapXMutation,
    },
  } satisfies PersistedQueryClientSaveOptions;
  const subscribe = async () => {
    cleanups.push(subscribeRecentMapDataPersistence(options));
    await vi.advanceTimersByTimeAsync(1000);
    persistClient.mockClear();
    snapshots.length = 0;
    shouldDehydrateQuery.mockClear();
  };
  cleanups.push(() => queryClient.clear());
  return { queryClient, persistClient, shouldDehydrateQuery, options, subscribe, snapshots };
}

describe("recent map query persistence", () => {
  it("does not snapshot the cache for autocomplete or observer churn", async () => {
    const f = fixture();
    for (let i = 0; i < 200; i++) f.queryClient.setQueryData(["place", i], { name: `place-${i}` });
    f.queryClient.setQueryData(["autocomplete", "query"], []);
    await f.subscribe();
    for (let i = 0; i < 20; i++) f.queryClient.setQueryData(["autocomplete", "query"], [i]);
    const observer = new QueryObserver(f.queryClient, { queryKey: ["place", 0], enabled: false });
    observer.subscribe(() => {})();
    await vi.advanceTimersByTimeAsync(2000);
    expect(f.persistClient).not.toHaveBeenCalled();
    expect(f.shouldDehydrateQuery).not.toHaveBeenCalled();
  });

  it("coalesces eligible bursts before traversal and saves the latest data", async () => {
    const f = fixture();
    for (let i = 0; i < 200; i++) f.queryClient.setQueryData(["place", i], i);
    await f.subscribe();
    for (let i = 0; i < 20; i++) f.queryClient.setQueryData(["place", 0], i);
    expect(f.persistClient).not.toHaveBeenCalled();
    expect(f.shouldDehydrateQuery).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.persistClient).toHaveBeenCalledTimes(1);
    expect(f.shouldDehydrateQuery).toHaveBeenCalledTimes(200);
    const snapshot = f.snapshots[0];
    expect(snapshot?.buster).toBe(PERSONAL_TIMELINE_CACHE_BUSTER);
    expect(snapshot?.clientState.queries.find((q) => q.queryKey[1] === 0)?.state.data).toBe(19);
  });

  it("does no snapshot work while disabled, then saves existing data on opt-in", async () => {
    const f = fixture();
    localStorage.removeItem(RECENT_MAP_DATA_CACHE_ENABLED_KEY);
    await f.subscribe();
    f.queryClient.setQueryData(["place", 1], "offline");
    await vi.advanceTimersByTimeAsync(2000);
    expect(f.persistClient).not.toHaveBeenCalled();
    expect(f.shouldDehydrateQuery).not.toHaveBeenCalled();
    await setRecentMapDataCacheEnabled(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.persistClient).toHaveBeenCalledTimes(1);
    expect(f.snapshots[0]?.clientState.queries[0]?.state.data).toBe("offline");
  });

  it.each(["opt-out", "clear", "teardown"])("cancels queued work on %s", async (reason) => {
    const f = fixture();
    await f.subscribe();
    f.queryClient.setQueryData(["place", 1], "queued");
    if (reason === "opt-out") await setRecentMapDataCacheEnabled(false);
    if (reason === "clear") await clearRecentMapDataCache();
    if (reason === "teardown") for (const cleanup of cleanups.splice(0)) cleanup();
    await vi.advanceTimersByTimeAsync(2000);
    expect(f.persistClient).not.toHaveBeenCalled();
    expect(f.shouldDehydrateQuery).not.toHaveBeenCalled();
  });

  it("persists removals and does not retain stale data from an earlier queued update", async () => {
    const f = fixture();
    f.queryClient.setQueryData(["place", 1], "old");
    await f.subscribe();
    f.queryClient.setQueryData(["place", 1], "queued");
    f.queryClient.removeQueries({ queryKey: ["place", 1] });
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.persistClient).toHaveBeenCalledTimes(1);
    expect(f.snapshots[0]?.clientState.queries).toEqual([]);
  });

  it("drops previously successful queries when their latest fetch fails", async () => {
    const f = fixture();
    f.queryClient.setQueryData(["place", 1], "old");
    await f.subscribe();
    await expect(
      f.queryClient.fetchQuery({
        queryKey: ["place", 1],
        queryFn: async () => {
          throw new Error("failed");
        },
        retry: false,
      }),
    ).rejects.toThrow("failed");
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.persistClient).toHaveBeenCalledTimes(1);
    expect(f.snapshots[0]?.clientState.queries).toEqual([]);
  });

  it("handles another tab's preference changes and stops listening after teardown", async () => {
    const f = fixture();
    await f.subscribe();
    f.queryClient.setQueryData(["place", 1], "queued");
    localStorage.removeItem(RECENT_MAP_DATA_CACHE_ENABLED_KEY);
    window.dispatchEvent(new StorageEvent("storage", { key: RECENT_MAP_DATA_CACHE_ENABLED_KEY }));
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.persistClient).not.toHaveBeenCalled();
    localStorage.setItem(RECENT_MAP_DATA_CACHE_ENABLED_KEY, "true");
    window.dispatchEvent(new StorageEvent("storage", { key: RECENT_MAP_DATA_CACHE_ENABLED_KEY }));
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.persistClient).toHaveBeenCalledTimes(1);
    f.persistClient.mockClear();
    for (const cleanup of cleanups.splice(0)) cleanup();
    window.dispatchEvent(new StorageEvent("storage", { key: RECENT_MAP_DATA_CACHE_ENABLED_KEY }));
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.persistClient).not.toHaveBeenCalled();
  });

  it("excludes timeline secrets and retains/removes other paused mutations", async () => {
    const f = fixture();
    await f.subscribe();
    const state = {
      context: undefined,
      data: undefined,
      error: null,
      failureCount: 0,
      failureReason: null,
      isPaused: true,
      status: "pending" as const,
      submittedAt: Date.now(),
      variables: { apiKey: "secret" },
    };
    f.queryClient
      .getMutationCache()
      .build(f.queryClient, { mutationKey: ["personalTimeline", "connect"] }, state);
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.persistClient).not.toHaveBeenCalled();
    const safeMutation = f.queryClient
      .getMutationCache()
      .build(
        f.queryClient,
        { mutationKey: ["unrelated", "write"] },
        { ...state, variables: { safe: true } },
      );
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.persistClient).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(f.snapshots[0])).not.toContain("secret");
    expect(f.snapshots[0]?.clientState.mutations).toHaveLength(1);
    f.persistClient.mockClear();
    f.queryClient.getMutationCache().remove(safeMutation);
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.snapshots.at(-1)?.clientState.mutations).toEqual([]);
  });
});
