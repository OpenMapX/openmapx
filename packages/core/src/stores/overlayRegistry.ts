import type { LoadedIntegrationMeta } from "../integration/loader";
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

type StoreHook = {
  getState: () => OverlayStoreBase;
  <T>(selector: (s: OverlayStoreBase) => T): T;
};

/**
 * Static mapping from overlay ID to its Zustand store hook.
 * Adding a new overlay requires adding an entry here + creating the store file.
 */
const OVERLAY_STORE_MAP: Record<string, StoreHook> = {
  traffic: useTrafficStore as unknown as StoreHook,
  transit: useTransitStore as unknown as StoreHook,
  "street-view": useStreetViewStore as unknown as StoreHook,
  "air-quality": useAirQualityStore as unknown as StoreHook,
  earthquakes: useEarthquakeStore as unknown as StoreHook,
  wildfires: useWildfireStore as unknown as StoreHook,
  "winter-sports": useWinterSportsStore as unknown as StoreHook,
  hiking: useHikingStore as unknown as StoreHook,
  cycling: useCyclingStore as unknown as StoreHook,
  "live-trains": useLiveTrainsStore as unknown as StoreHook,
  "3d-buildings": useBuildingsStore as unknown as StoreHook,
};

/** Convert integration ID to overlay ID */
function integrationIdToOverlayId(integrationId: string): string {
  if (integrationId === "overlay-traffic-tomtom") return "traffic";
  if (integrationId === "street-view-mapillary") return "street-view";
  return integrationId.replace(/^overlay-/, "").replace(/^tool-/, "");
}

const overlayEntries: OverlayEntry[] = [];

/** Read-only view of the registry. */
export const OVERLAY_REGISTRY: readonly OverlayEntry[] = overlayEntries;

/** Register a new overlay entry at runtime (used by integration framework). */
export function registerOverlayEntry(entry: OverlayEntry): void {
  if (overlayEntries.some((e) => e.id === entry.id)) return;
  overlayEntries.push(entry);
}

/**
 * Initialize the overlay registry from integration manifest data.
 * Called by IntegrationProvider after fetching integration metadata.
 * Reads exclusion rules and serviceId from manifests, wires to store hooks.
 */
export function initOverlayRegistry(integrations: LoadedIntegrationMeta[]): void {
  // Clear any existing entries to avoid duplicates on re-init
  overlayEntries.length = 0;

  for (const integration of integrations) {
    if (!integration.enabled) continue;
    if (!integration.frontend?.overlay) continue;

    const overlayId = integrationIdToOverlayId(integration.id);
    const storeHook = OVERLAY_STORE_MAP[overlayId];
    if (!storeHook) continue;

    const overlay = integration.frontend.overlay as {
      excludes?: string[];
      minZoom?: number;
    };

    overlayEntries.push({
      id: overlayId,
      serviceId: integration.id,
      getState: () => storeHook.getState(),
      useActive: () => storeHook((s: OverlayStoreBase) => s.panelOpen && s.layerVisible),
      excludes: overlay.excludes ?? [],
    });
  }

  // Add overlays that have stores but may not have integration manifests yet
  // (e.g., transit, tools) - these get basic entries with no exclusions
  for (const [id, hook] of Object.entries(OVERLAY_STORE_MAP)) {
    if (overlayEntries.some((e) => e.id === id)) continue;
    overlayEntries.push({
      id,
      getState: () => hook.getState(),
      useActive: () => hook((s: OverlayStoreBase) => s.panelOpen && s.layerVisible),
      excludes: [],
    });
  }
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
