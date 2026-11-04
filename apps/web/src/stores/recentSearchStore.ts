import { getStorage, useSettingsStore } from "@openmapx/core";
import { type CarDestination, carDestinationSchema } from "@openmapx/core/navigation";
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
  destinations: CarDestination[];
  addDestination: (input: unknown) => void;
  add: (query: string) => void;
  clear: () => void;
  /** Re-read saved queries after the browser storage adapter is configured. */
  hydrate: () => void;
}

export const useRecentSearchStore = create<RecentSearchState>((set, get) => ({
  entries: [],
  destinations: [],
  addDestination: (input) => {
    if (!useSettingsStore.getState().searchHistoryEnabled) return;
    const parsed = carDestinationSchema.safeParse(input);
    if (!parsed.success) return;
    const destinations = [
      parsed.data,
      ...get().destinations.filter((p) => p.id !== parsed.data.id),
    ].slice(0, 20);
    getStorage().setString("openmapx:recentDestinations", JSON.stringify(destinations));
    set({ destinations });
  },
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
    getStorage().remove("openmapx:recentDestinations");
    set({ entries: [], destinations: [] });
  },
  hydrate: () => {
    if (
      !useSettingsStore.getState().searchHistoryEnabled ||
      getStorage().getString(SETTING_KEY) === "false"
    ) {
      get().clear();
      return;
    }
    let destinations: CarDestination[] = [];
    try {
      const parsed: unknown = JSON.parse(
        getStorage().getString("openmapx:recentDestinations") ?? "[]",
      );
      if (Array.isArray(parsed))
        destinations = parsed
          .flatMap((p) => {
            const result = carDestinationSchema.safeParse(p);
            return result.success ? [result.data] : [];
          })
          .slice(0, 20);
    } catch {}
    set({ entries: readEntries(), destinations });
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

/** An account switch must not republish the previous user's coordinate history. */
export function scopeRecentDestinations(account: string | null) {
  const storage = getStorage();
  const scope = account ?? "signed-out";
  if (storage.getString("openmapx:recentDestinationAccount") !== scope) {
    storage.setString("openmapx:recentDestinationAccount", scope);
    storage.remove("openmapx:recentDestinations");
    useRecentSearchStore.setState({ destinations: [] });
    return [];
  }
  return useRecentSearchStore.getState().destinations;
}
