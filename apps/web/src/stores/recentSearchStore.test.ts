import { configureStorage, type StorageAdapter, useSettingsStore } from "@openmapx/core";
import { beforeEach, describe, expect, it } from "vitest";
import { subscribeRecentSearchStorage, useRecentSearchStore } from "./recentSearchStore";

function memoryStorage(): StorageAdapter {
  const values = new Map<string, string>();
  return {
    getString: (key) => values.get(key) ?? null,
    setString: (key, value) => {
      values.set(key, value);
    },
    remove: (key) => {
      values.delete(key);
    },
  };
}

let storage: StorageAdapter;

beforeEach(() => {
  storage = memoryStorage();
  configureStorage(storage);
  useSettingsStore.getState().hydrate();
  useRecentSearchStore.getState().clear();
});

describe("useRecentSearchStore", () => {
  it("hydrates saved queries in newest-first order", () => {
    storage.setString("openmapx:recentSearches", '["Berlin","Paris"]');
    useRecentSearchStore.getState().hydrate();
    expect(useRecentSearchStore.getState().entries).toEqual(["Berlin", "Paris"]);
  });

  it("trims queries, deduplicates without case, and keeps only the newest ten", () => {
    const { add } = useRecentSearchStore.getState();
    for (let n = 0; n < 11; n++) add(`City ${n}`);
    add("  CITY 5  ");
    add("   ");

    expect(useRecentSearchStore.getState().entries).toEqual([
      "CITY 5",
      "City 10",
      "City 9",
      "City 8",
      "City 7",
      "City 6",
      "City 4",
      "City 3",
      "City 2",
      "City 1",
    ]);
    expect(JSON.parse(storage.getString("openmapx:recentSearches") ?? "null")).toEqual(
      useRecentSearchStore.getState().entries,
    );
  });

  it("clear removes saved and visible history", () => {
    useRecentSearchStore.getState().add("Berlin");
    useRecentSearchStore.getState().clear();
    expect(useRecentSearchStore.getState().entries).toEqual([]);
    expect(storage.getString("openmapx:recentSearches")).toBeNull();
  });

  it("disabling clears history, blocks writes, and re-enabling starts empty", () => {
    useRecentSearchStore.getState().add("Berlin");
    useSettingsStore.getState().setSearchHistoryEnabled(false);

    expect(useRecentSearchStore.getState().entries).toEqual([]);
    expect(storage.getString("openmapx:recentSearches")).toBeNull();
    useRecentSearchStore.getState().add("Paris");
    storage.setString("openmapx:recentSearches", '["Old query"]');
    useRecentSearchStore.getState().hydrate();
    expect(useRecentSearchStore.getState().entries).toEqual([]);
    expect(storage.getString("openmapx:recentSearches")).toBeNull();

    useSettingsStore.getState().setSearchHistoryEnabled(true);
    expect(useRecentSearchStore.getState().entries).toEqual([]);
    useRecentSearchStore.getState().add("Rome");
    expect(useRecentSearchStore.getState().entries).toEqual(["Rome"]);
  });

  it("does not write when another tab has disabled history", () => {
    useRecentSearchStore.getState().add("Berlin");
    storage.setString("openmapx:searchHistoryEnabled", "false");

    useRecentSearchStore.getState().add("Paris");

    expect(useRecentSearchStore.getState().entries).toEqual([]);
    expect(storage.getString("openmapx:recentSearches")).toBeNull();
  });

  it("updates visible history when another tab disables it", () => {
    useRecentSearchStore.getState().add("Berlin");
    const unsubscribe = subscribeRecentSearchStorage();
    try {
      storage.setString("openmapx:searchHistoryEnabled", "false");
      storage.remove("openmapx:recentSearches");
      window.dispatchEvent(new StorageEvent("storage", { key: "openmapx:searchHistoryEnabled" }));

      expect(useSettingsStore.getState().searchHistoryEnabled).toBe(false);
      expect(useRecentSearchStore.getState().entries).toEqual([]);
    } finally {
      unsubscribe();
    }
  });

  it("drops malformed saved data", () => {
    storage.setString("openmapx:recentSearches", "{broken");
    useRecentSearchStore.getState().hydrate();
    expect(useRecentSearchStore.getState().entries).toEqual([]);
  });
});
