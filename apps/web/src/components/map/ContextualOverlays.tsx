"use client";

import { useLiveTransitStore } from "@integrations/overlay-live-transit/store";
import { useTrafficFlowStore } from "@integrations/overlay-traffic-flow/store";
import { useTransitStore } from "@integrations/overlay-transit/store";
import { useRoadConditionsStore } from "@integrations/road-conditions/store";
import { useDirectionsStore, useNavigationStore } from "@openmapx/core";
import { useEffect, useMemo, useRef } from "react";

type OverlayContext = "transit-planning" | "transit-nav" | "driving-planning" | "driving-nav";

/** The slice of any overlay store this mechanism needs to read/toggle. */
interface ContextualOverlayStore {
  getState: () => { layerVisible: boolean; setLayerVisible: (visible: boolean) => void };
}

/**
 * Overlays that switch on automatically for a given trip context and switch back
 * to the user's prior choice when the context ends. Extending is one entry: list
 * the overlay's store and the contexts it belongs to. A manual toggle is never
 * overridden — an overlay the user already turned on stays on when the context ends.
 */
const CONTEXTUAL_OVERLAYS: Array<{ store: ContextualOverlayStore; contexts: OverlayContext[] }> = [
  // Live vehicles + the static transit-line map, while planning or riding transit.
  { store: useLiveTransitStore, contexts: ["transit-planning", "transit-nav"] },
  { store: useTransitStore, contexts: ["transit-planning", "transit-nav"] },
  // Traffic incidents + flow, while planning or driving a car/motorcycle route.
  { store: useRoadConditionsStore, contexts: ["driving-planning", "driving-nav"] },
  { store: useTrafficFlowStore, contexts: ["driving-planning", "driving-nav"] },
];

const DRIVING_MODES = new Set(["driving", "motorcycle"]);

/**
 * Drives {@link CONTEXTUAL_OVERLAYS}: enables the mapped overlays while the user
 * is planning or navigating in a matching context, and restores their prior
 * on/off choice on exit.
 */
export function ContextualOverlays() {
  const directionsOpen = useDirectionsStore((s) => s.isOpen);
  const directionsMode = useDirectionsStore((s) => s.mode);
  const navKind = useNavigationStore((s) => s.kind);
  const navMode = useNavigationStore((s) => s.mode);
  const navStatus = useNavigationStore((s) => s.status);

  const active = useMemo(() => {
    const set = new Set<OverlayContext>();
    if (directionsOpen && directionsMode === "transit") set.add("transit-planning");
    if (directionsOpen && DRIVING_MODES.has(directionsMode)) set.add("driving-planning");
    const navigating = navStatus !== "idle";
    if (navigating && navKind === "transit") set.add("transit-nav");
    if (navigating && navKind === "ground" && DRIVING_MODES.has(navMode)) set.add("driving-nav");
    return set;
  }, [directionsOpen, directionsMode, navKind, navMode, navStatus]);

  // Indices of overlays this mechanism turned on, so it only turns back off the
  // ones it enabled (never a manual toggle).
  const autoEnabledRef = useRef<Set<number>>(new Set());

  useEffect(() => {
    CONTEXTUAL_OVERLAYS.forEach((entry, index) => {
      const want = entry.contexts.some((context) => active.has(context));
      const state = entry.store.getState();
      if (want) {
        if (!state.layerVisible) {
          state.setLayerVisible(true);
          autoEnabledRef.current.add(index);
        }
      } else if (autoEnabledRef.current.has(index)) {
        entry.store.getState().setLayerVisible(false);
        autoEnabledRef.current.delete(index);
      }
    });
  }, [active]);

  return null;
}
