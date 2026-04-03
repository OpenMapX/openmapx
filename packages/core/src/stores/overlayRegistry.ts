import type { LoadedIntegrationMeta } from "../integration/loader";
import {
  createOverlayStore,
  getRegisteredOverlayIds,
  getRegisteredOverlayStore,
  type OverlayStoreBase,
} from "./createOverlayStore";

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
 * Reads exclusion rules and serviceId from manifests, wires to store hooks
 * that have been dynamically registered via createOverlayStore({ overlayId }).
 */
export function initOverlayRegistry(integrations: LoadedIntegrationMeta[]): void {
  // Clear any existing entries to avoid duplicates on re-init
  overlayEntries.length = 0;

  for (const integration of integrations) {
    if (!integration.enabled) continue;
    if (!integration.frontend?.overlay) continue;

    const overlayId = integrationIdToOverlayId(integration.id);
    let storeHook = getRegisteredOverlayStore(overlayId) as StoreHook | undefined;

    // Auto-create a basic overlay store for integrations that don't have a
    // pre-registered store. This lets new simple overlays work with just a
    // manifest — no store file needed (plan section 8.3).
    if (!storeHook) {
      const autoStore = createOverlayStore({ overlayId, extra: {} });
      storeHook = autoStore as unknown as StoreHook;
    }

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
  for (const id of getRegisteredOverlayIds()) {
    if (overlayEntries.some((e) => e.id === id)) continue;
    const hook = getRegisteredOverlayStore(id) as StoreHook | undefined;
    if (!hook) continue;
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
