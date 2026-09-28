import { getStorage, useSettingsStore } from "@openmapx/core";
import { create } from "zustand";

const STORAGE_KEY = "openmapx:recentSearches";
const SETTING_KEY = "openmapx:searchHistoryEnabled";
const MAX_ENTRIES = 10;

function normalize(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  const seen = new Set<string>();
  const entries: string[] = [];
  for (const value of values) {
    if (typeof value !== "string") continue;
    const query = value.trim();
    const key = query.toLocaleLowerCase();
    if (!query || seen.has(key)) continue;
    seen.add(key);
    entries.push(query);
    if (entries.length === MAX_ENTRIES) break;
  }
  return entries;
}

function readEntries(): string[] {
  const raw = getStorage().getString(STORAGE_KEY);
  if (!raw) return [];
  try {
    return normalize(JSON.parse(raw));
  } catch {
    return [];
  }
}

interface RecentSearchState {
  entries: string[];
  add: (query: string) => void;
  clear: () => void;
  /** Re-read saved queries after the browser storage adapter is configured. */
  hydrate: () => void;
}

export const useRecentSearchStore = create<RecentSearchState>((set, get) => ({
  entries: [],
  add: (query) => {
    if (
      !useSettingsStore.getState().searchHistoryEnabled ||
      getStorage().getString(SETTING_KEY) === "false"
    ) {
      get().clear();
      return;
    }
    const entries = normalize([query, ...get().entries]);
    if (!entries.length) return;
    getStorage().setString(STORAGE_KEY, JSON.stringify(entries));
    set({ entries });
  },
  clear: () => {
    getStorage().remove(STORAGE_KEY);
    set({ entries: [] });
  },
  hydrate: () => {
    if (
      !useSettingsStore.getState().searchHistoryEnabled ||
      getStorage().getString(SETTING_KEY) === "false"
    ) {
      get().clear();
      return;
    }
    set({ entries: readEntries() });
  },
}));

useSettingsStore.subscribe((state, previous) => {
  if (!state.searchHistoryEnabled && previous.searchHistoryEnabled) {
    useRecentSearchStore.getState().clear();
  }
});

/** Keep an already-open tab in sync when another tab changes local history. */
export function subscribeRecentSearchStorage(): () => void {
  if (typeof window === "undefined") return () => {};
  const onStorage = (event: StorageEvent) => {
    if (event.key !== SETTING_KEY && event.key !== STORAGE_KEY && event.key !== null) return;
    useSettingsStore.getState().hydrate();
    useRecentSearchStore.getState().hydrate();
  };
  window.addEventListener("storage", onStorage);
  return () => window.removeEventListener("storage", onStorage);
}
