import type { PersistedClient } from "@tanstack/react-query-persist-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { idbDelete, idbSet } from "./idbStore";
import { createIdbPersister } from "./queryPersister";
import {
  clearRecentMapDataCache,
  RECENT_MAP_DATA_CACHE_ENABLED_KEY,
  setRecentMapDataCacheEnabled,
} from "./recentMapDataCache";

const getMock = vi.hoisted(() => vi.fn());
vi.mock("./idbStore", () => ({
  idbDelete: vi.fn(async () => {}),
  idbGet: getMock,
  idbSet: vi.fn(async () => {}),
}));
const snapshot: PersistedClient = {
  timestamp: Date.now(),
  buster: "test",
  clientState: { queries: [], mutations: [] },
};
beforeEach(() => {
  vi.clearAllMocks();
  getMock.mockReset();
  localStorage.setItem(RECENT_MAP_DATA_CACHE_ENABLED_KEY, "true");
});
afterEach(() => {
  localStorage.clear();
});

describe("IndexedDB query storage", () => {
  it("writes the already-coalesced snapshot without a second pending timer", async () => {
    const persister = createIdbPersister("test-cache");
    await persister.persistClient(snapshot);
    expect(idbSet).toHaveBeenCalledWith("test-cache", snapshot);
  });
  it("does not read or write while opted out", async () => {
    localStorage.removeItem(RECENT_MAP_DATA_CACHE_ENABLED_KEY);
    const persister = createIdbPersister("test-cache");
    await persister.persistClient(snapshot);
    expect(await persister.restoreClient()).toBeUndefined();
    expect(idbSet).not.toHaveBeenCalled();
    expect(getMock).not.toHaveBeenCalled();
  });
  it.each(["opt-out", "clear", "remove"])("rejects a late restore after %s", async (reason) => {
    let release!: (client: PersistedClient) => void;
    getMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const persister = createIdbPersister("test-cache");
    const restore = persister.restoreClient();
    if (reason === "opt-out") await setRecentMapDataCacheEnabled(false);
    if (reason === "clear") await clearRecentMapDataCache();
    if (reason === "remove") await persister.removeClient();
    release(snapshot);
    expect(await restore).toBeUndefined();
  });
  it("restores the opted-in stored cache and supports explicit removal", async () => {
    getMock.mockResolvedValue(snapshot);
    const persister = createIdbPersister("test-cache");
    expect(await persister.restoreClient()).toBe(snapshot);
    await persister.removeClient();
    expect(idbDelete).toHaveBeenCalledWith("test-cache");
  });

  it("rejects a deferred snapshot after another tab opts out and back in during restore", async () => {
    let release!: (client: PersistedClient) => void;
    getMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const restore = createIdbPersister("test-cache").restoreClient();
    localStorage.removeItem(RECENT_MAP_DATA_CACHE_ENABLED_KEY);
    window.dispatchEvent(new StorageEvent("storage", { key: RECENT_MAP_DATA_CACHE_ENABLED_KEY }));
    localStorage.setItem(RECENT_MAP_DATA_CACHE_ENABLED_KEY, "true");
    window.dispatchEvent(new StorageEvent("storage", { key: RECENT_MAP_DATA_CACHE_ENABLED_KEY }));
    release(snapshot);
    expect(await restore).toBeUndefined();
  });
});
