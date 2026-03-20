import { useAirQualityStore } from "./airQualityStore";
import type { OverlayStoreBase } from "./createOverlayStore";
import { useCyclingStore } from "./cyclingStore";
import { useEarthquakeStore } from "./earthquakeStore";
import { useHikingStore } from "./hikingStore";
import { useStreetViewStore } from "./streetViewStore";
import { useWinterSportsStore } from "./winterSportsStore";

export type OverlayId =
  | "street-view"
  | "air-quality"
  | "earthquakes"
  | "winter-sports"
  | "hiking"
  | "cycling";

export interface OverlayEntry {
  id: OverlayId;
  getState: () => OverlayStoreBase;
  useActive: () => boolean;
  excludes: OverlayId[];
}

export const OVERLAY_REGISTRY: readonly OverlayEntry[] = [
  {
    id: "street-view",
    getState: () => useStreetViewStore.getState(),
    useActive: () => useStreetViewStore((s) => s.panelOpen && s.layerVisible),
    excludes: ["air-quality", "winter-sports", "hiking", "earthquakes"],
  },
  {
    id: "air-quality",
    getState: () => useAirQualityStore.getState(),
    useActive: () => useAirQualityStore((s) => s.panelOpen && s.layerVisible),
    excludes: ["street-view", "winter-sports", "earthquakes", "hiking"],
  },
  {
    id: "earthquakes",
    getState: () => useEarthquakeStore.getState(),
    useActive: () => useEarthquakeStore((s) => s.panelOpen && s.layerVisible),
    excludes: ["street-view", "air-quality"],
  },
  {
    id: "winter-sports",
    getState: () => useWinterSportsStore.getState(),
    useActive: () => useWinterSportsStore((s) => s.panelOpen && s.layerVisible),
    excludes: ["street-view", "air-quality"],
  },
  {
    id: "hiking",
    getState: () => useHikingStore.getState(),
    useActive: () => useHikingStore((s) => s.panelOpen && s.layerVisible),
    excludes: ["street-view", "air-quality"],
  },
  {
    id: "cycling",
    getState: () => useCyclingStore.getState(),
    useActive: () => useCyclingStore((s) => s.panelOpen && s.layerVisible),
    excludes: [],
  },
];

export function getOverlayEntry(id: OverlayId): OverlayEntry | undefined {
  return OVERLAY_REGISTRY.find((entry) => entry.id === id);
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
