import type { LoadedIntegrationMeta } from "../types/integrationMeta";
import {
  createOverlayStore,
  getRegisteredOverlayIds,
  getRegisteredOverlayStore,
  type OverlayStoreBase,
  runInOverlayTransaction,
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
export function integrationIdToOverlayId(integrationId: string): string {
  if (integrationId === "overlay-traffic-tomtom") return "traffic";
  // Every street-level-imagery provider shares a single overlay toggle and exclusion group.
  if (integrationId.startsWith("street-level-imagery-")) return "street-level-imagery";
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

    // Use dynamic lookup so that when the real store (from a lazy-loaded
    // map-layer.tsx) overwrites the auto-created store in the registry,
    // getState/useActive always reference the current store instance.
    const oid = overlayId;
    overlayEntries.push({
      id: oid,
      serviceId: integration.id,
      getState: () => {
        const current = getRegisteredOverlayStore(oid) as StoreHook | undefined;
        return current
          ? current.getState()
          : {
              panelOpen: false,
              layerVisible: false,
              userRevision: 0,
              openPanel: () => {},
              closePanel: () => {},
              setLayerVisible: () => {},
            };
      },
      useActive: () => {
        const current = getRegisteredOverlayStore(oid) as StoreHook | undefined;
        if (!current) return false;
        return current((s: OverlayStoreBase) => s.panelOpen && s.layerVisible);
      },
      excludes: overlay.excludes ?? [],
    });
  }

  // Add overlays that have stores but may not have integration manifests yet
  // (e.g., transit, tools) - these get basic entries with no exclusions
  for (const id of getRegisteredOverlayIds()) {
    if (overlayEntries.some((e) => e.id === id)) continue;
    const storeId = id;
    overlayEntries.push({
      id: storeId,
      getState: () => {
        const current = getRegisteredOverlayStore(storeId) as StoreHook | undefined;
        return current
          ? current.getState()
          : {
              panelOpen: false,
              layerVisible: false,
              userRevision: 0,
              openPanel: () => {},
              closePanel: () => {},
              setLayerVisible: () => {},
            };
      },
      useActive: () => {
        const current = getRegisteredOverlayStore(storeId) as StoreHook | undefined;
        if (!current) return false;
        return current((s: OverlayStoreBase) => s.panelOpen && s.layerVisible);
      },
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

export function isOverlayActive(overlayId: OverlayId): boolean {
  const entry = getOverlayEntry(overlayId);
  if (!entry) return false;
  const state = entry.getState();
  return state.panelOpen && state.layerVisible;
}

/**
 * Who made a change through runOverlayTransaction/toggleOverlay. Every
 * production call site must supply one, so it's always possible to tell
 * contextual automation's own writes apart from a change nothing but the
 * user (or an unrelated system transition) could have made — the distinction
 * restoreOverlaySnapshot depends on to know when a user choice must win.
 */
export type OverlayChangeOrigin =
  | { kind: "user" }
  | { kind: "automation"; owner: string }
  | { kind: "system"; reason: string };

export interface OverlaySnapshotEntry {
  id: OverlayId;
  panelOpen: boolean;
  layerVisible: boolean;
  userRevision: number;
}

export interface OverlayTransactionRecord {
  /** Monotonic across every transaction, regardless of which overlay(s) it touched. */
  revision: number;
  origin: OverlayChangeOrigin;
  targetId: OverlayId;
  before: OverlaySnapshotEntry[];
  after: OverlaySnapshotEntry[];
}

let overlayTransactionRevision = 0;

function snapshotOverlay(id: OverlayId): OverlaySnapshotEntry | undefined {
  const entry = getOverlayEntry(id);
  if (!entry) return undefined;
  const state = entry.getState();
  return {
    id,
    panelOpen: state.panelOpen,
    layerVisible: state.layerVisible,
    userRevision: state.userRevision,
  };
}

/**
 * The full set of overlays a transaction on `overlayId` can touch: the
 * overlay itself plus every overlay it excludes. Opening it closes those
 * peers, so any snapshot/restore around the change has to cover all of them,
 * not just the target — otherwise a displaced peer is captured incompletely
 * (or not at all) and can never be restored.
 */
export function overlayTransactionClosure(overlayId: OverlayId): OverlayId[] {
  const entry = getOverlayEntry(overlayId);
  if (!entry) return [overlayId];
  return [overlayId, ...entry.excludes];
}

/**
 * Applies a desired panelOpen/layerVisible state to `overlayId` through the
 * public store actions (openPanel/closePanel/setLayerVisible — the same ones
 * every direct caller uses), while recording a single before/after snapshot
 * of the full exclusion closure — including any peer it closes along the way,
 * which a caller applying the actions itself one at a time would never think
 * to capture together.
 *
 * Only an "automation" origin suppresses the userRevision bump (via
 * runInOverlayTransaction) on every write this touches. A "user" or "system"
 * origin applies the exact same writes WITHOUT suppression, so each one bumps
 * userRevision exactly like the direct call it's standing in for would —
 * critical for e.g. the layer selector's toggleOverlay: a user turning an
 * auto-enabled overlay off has to read as user intent (bumped revision) so a
 * later contextual restore knows not to turn it back on.
 */
export function runOverlayTransaction(
  overlayId: OverlayId,
  desired: { panelOpen: boolean; layerVisible?: boolean },
  origin: OverlayChangeOrigin,
): OverlayTransactionRecord | undefined {
  const entry = getOverlayEntry(overlayId);
  if (!entry) return undefined;

  const closureIds = overlayTransactionClosure(overlayId);
  const before = closureIds
    .map(snapshotOverlay)
    .filter((snap): snap is OverlaySnapshotEntry => Boolean(snap));

  const apply = () => {
    if (desired.panelOpen) {
      closeExclusionPeers(overlayId);
      entry.getState().openPanel();
      if (desired.layerVisible === false) entry.getState().setLayerVisible(false);
    } else {
      entry.getState().closePanel();
    }
  };

  if (origin.kind === "automation") {
    runInOverlayTransaction(apply);
  } else {
    apply();
  }

  const after = closureIds
    .map(snapshotOverlay)
    .filter((snap): snap is OverlaySnapshotEntry => Boolean(snap));

  overlayTransactionRevision += 1;
  return { revision: overlayTransactionRevision, origin, targetId: overlayId, before, after };
}

/**
 * Restores each captured entry's panelOpen/layerVisible through the public
 * store actions, but only for entries whose userRevision is still exactly
 * what it was when the snapshot was taken. A changed userRevision means a
 * direct (user/external) write landed on that overlay after the snapshot —
 * including one that happened to set the same value the snapshot already
 * had — and per the "a manual change always wins" rule, that write is never
 * overridden by an automation restore, so it's skipped rather than reapplied.
 */
export function restoreOverlaySnapshot(entries: OverlaySnapshotEntry[]): void {
  runInOverlayTransaction(() => {
    for (const snapshot of entries) {
      const entry = getOverlayEntry(snapshot.id);
      if (!entry) continue;
      const state = entry.getState();
      if (state.userRevision !== snapshot.userRevision) continue;
      if (snapshot.panelOpen) {
        state.openPanel();
        if (!snapshot.layerVisible) state.setLayerVisible(false);
      } else {
        state.closePanel();
      }
    }
  });
}

export function toggleOverlay(
  overlayId: OverlayId,
  origin: OverlayChangeOrigin,
): OverlayTransactionRecord | undefined {
  const entry = getOverlayEntry(overlayId);
  if (!entry) return undefined;
  const wasOpen = entry.getState().panelOpen;
  return runOverlayTransaction(overlayId, { panelOpen: !wasOpen }, origin);
}
