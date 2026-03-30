import { useAirQualityStore } from "./airQualityStore";
import { useBuildingsStore } from "./buildingsStore";
import type { OverlayStoreBase } from "./createOverlayStore";
import { useCyclingStore } from "./cyclingStore";
import { useEarthquakeStore } from "./earthquakeStore";
import { useHikingStore } from "./hikingStore";
import { useLiveTrainsStore } from "./liveTrainsStore";
import { useStreetViewStore } from "./streetViewStore";
import { useTrafficStore } from "./trafficStore";
import { useTransitStore } from "./transitStore";
import { useWildfireStore } from "./wildfireStore";
import { useWinterSportsStore } from "./winterSportsStore";

export type OverlayId = string;

export interface OverlayEntry {
  id: OverlayId;
  serviceId?: string;
  getState: () => OverlayStoreBase;
  useActive: () => boolean;
  excludes: OverlayId[];
}

const overlayEntries: OverlayEntry[] = [
  {
    id: "traffic",
    serviceId: "tomtom-traffic",
    getState: () => useTrafficStore.getState(),
    useActive: () => useTrafficStore((s) => s.panelOpen && s.layerVisible),
    excludes: [],
  },
  {
    id: "transit",
    getState: () => useTransitStore.getState(),
    useActive: () => useTransitStore((s) => s.panelOpen && s.layerVisible),
    excludes: [],
  },
  {
    id: "street-view",
    serviceId: "mapillary",
    getState: () => useStreetViewStore.getState(),
    useActive: () => useStreetViewStore((s) => s.panelOpen && s.layerVisible),
    excludes: ["air-quality", "earthquakes", "wildfires", "winter-sports", "hiking"],
  },
  {
    id: "air-quality",
    serviceId: "openaq",
    getState: () => useAirQualityStore.getState(),
    useActive: () => useAirQualityStore((s) => s.panelOpen && s.layerVisible),
    excludes: ["street-view", "earthquakes", "wildfires"],
  },
  {
    id: "earthquakes",
    getState: () => useEarthquakeStore.getState(),
    useActive: () => useEarthquakeStore((s) => s.panelOpen && s.layerVisible),
    excludes: ["street-view", "air-quality", "wildfires"],
  },
  {
    id: "wildfires",
    serviceId: "firms-wildfires",
    getState: () => useWildfireStore.getState(),
    useActive: () => useWildfireStore((s) => s.panelOpen && s.layerVisible),
    excludes: ["street-view", "air-quality", "earthquakes"],
  },
  {
    id: "winter-sports",
    getState: () => useWinterSportsStore.getState(),
    useActive: () => useWinterSportsStore((s) => s.panelOpen && s.layerVisible),
    excludes: ["street-view", "hiking"],
  },
  {
    id: "hiking",
    getState: () => useHikingStore.getState(),
    useActive: () => useHikingStore((s) => s.panelOpen && s.layerVisible),
    excludes: ["street-view", "winter-sports"],
  },
  {
    id: "cycling",
    getState: () => useCyclingStore.getState(),
    useActive: () => useCyclingStore((s) => s.panelOpen && s.layerVisible),
    excludes: [],
  },
  {
    id: "live-trains",
    getState: () => useLiveTrainsStore.getState(),
    useActive: () => useLiveTrainsStore((s) => s.panelOpen && s.layerVisible),
    excludes: [],
  },
  {
    id: "3d-buildings",
    getState: () => useBuildingsStore.getState(),
    useActive: () => useBuildingsStore((s) => s.panelOpen && s.layerVisible),
    excludes: [],
  },
];

/** Read-only view of the registry (for backward compatibility). */
export const OVERLAY_REGISTRY: readonly OverlayEntry[] = overlayEntries;

/** Register a new overlay entry at runtime (used by integration framework). */
export function registerOverlayEntry(entry: OverlayEntry): void {
  if (overlayEntries.some((e) => e.id === entry.id)) return;
  overlayEntries.push(entry);
}

export function getOverlayEntry(id: OverlayId): OverlayEntry | undefined {
  return overlayEntries.find((entry) => entry.id === id);
}

export function closeExclusionPeers(overlayId: OverlayId): void {
  const entry = getOverlayEntry(overlayId);
  if (!entry) return;

  for (const peerId of entry.excludes) {
    const peer = getOverlayEntry(peerId);
    if (peer) {
      const state = peer.getState();
      if (state.panelOpen) state.closePanel();
    }
  }
}

export function toggleOverlay(overlayId: OverlayId): void {
  const entry = getOverlayEntry(overlayId);
  if (!entry) return;

  const state = entry.getState();
  if (state.panelOpen) {
    state.closePanel();
  } else {
    closeExclusionPeers(overlayId);
    state.openPanel();
  }
}

export function isOverlayActive(overlayId: OverlayId): boolean {
  const entry = getOverlayEntry(overlayId);
  if (!entry) return false;
  const state = entry.getState();
  return state.panelOpen && state.layerVisible;
}
