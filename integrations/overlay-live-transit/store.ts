import { createOverlayStore } from "@openmapx/core";
import type { TransportMode } from "@openmapx/mobility-core/transit";

const LIVE_TRANSIT_MODE_ORDER: TransportMode[] = [
  "rail",
  "subway",
  "tram",
  "bus",
  "ferry",
  "gondola",
  "funicular",
  "cable_car",
  "monorail",
];

const MODE_ORDER_INDEX = new Map(
  LIVE_TRANSIT_MODE_ORDER.map((mode, index) => [mode, index] as const),
);

function sortStrings(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function sortModes(values: Iterable<TransportMode>): TransportMode[] {
  return [...new Set(values)].sort((a, b) => {
    const aOrder = MODE_ORDER_INDEX.get(a) ?? Number.MAX_SAFE_INTEGER;
    const bOrder = MODE_ORDER_INDEX.get(b) ?? Number.MAX_SAFE_INTEGER;
    if (aOrder !== bOrder) return aOrder - bOrder;
    return a.localeCompare(b);
  });
}

function toggleExcludedValue<T extends string>(
  excluded: Set<T>,
  available: readonly T[],
  value: T,
): Set<T> {
  if (!available.includes(value)) return excluded;

  const next = new Set(excluded);
  if (next.has(value)) {
    next.delete(value);
    return next;
  }

  const activeCount = available.filter((candidate) => !next.has(candidate)).length;
  if (activeCount > 1) next.add(value);
  return next;
}

export const useLiveTransitStore = createOverlayStore({
  overlayId: "live-transit",
  extra: {
    loading: false,
    totalVehicleCount: 0,
    visibleVehicleCount: 0,
    lastUpdated: null as number | null,
    availableProviders: [] as string[],
    availableModes: [] as TransportMode[],
    availableCodespaces: [] as string[],
    excludedProviders: new Set<string>() as Set<string>,
    excludedModes: new Set<TransportMode>() as Set<TransportMode>,
    excludedCodespaces: new Set<string>() as Set<string>,
    selectedVehicleId: null as string | null,
  },
  actions: (set) => ({
    setLoading: (loading: boolean) => set({ loading }),
    setVehicleCounts: (totalVehicleCount: number, visibleVehicleCount: number) =>
      set({ totalVehicleCount, visibleVehicleCount }),
    setLastUpdated: (lastUpdated: number | null) => set({ lastUpdated }),
    setAvailableFilters: (filters: {
      providers: Iterable<string>;
      modes: Iterable<TransportMode>;
      codespaces: Iterable<string>;
    }) =>
      set({
        availableProviders: sortStrings(filters.providers),
        availableModes: sortModes(filters.modes),
        availableCodespaces: sortStrings(filters.codespaces),
      }),
    toggleProvider: (providerId: string) =>
      set((state) => ({
        excludedProviders: toggleExcludedValue(
          state.excludedProviders,
          state.availableProviders,
          providerId,
        ),
      })),
    toggleMode: (mode: TransportMode) =>
      set((state) => ({
        excludedModes: toggleExcludedValue(state.excludedModes, state.availableModes, mode),
      })),
    toggleCodespace: (codespaceId: string) =>
      set((state) => ({
        excludedCodespaces: toggleExcludedValue(
          state.excludedCodespaces,
          state.availableCodespaces,
          codespaceId,
        ),
      })),
    resetSnapshotMeta: () =>
      set({
        loading: false,
        totalVehicleCount: 0,
        visibleVehicleCount: 0,
        lastUpdated: null,
        availableProviders: [],
        availableModes: [],
        availableCodespaces: [],
      }),
    selectVehicle: (id: string | null) => set({ selectedVehicleId: id }),
  }),
  onClose: () => ({
    loading: false,
    totalVehicleCount: 0,
    visibleVehicleCount: 0,
    lastUpdated: null,
    availableProviders: [],
    availableModes: [],
    availableCodespaces: [],
    selectedVehicleId: null,
  }),
});
