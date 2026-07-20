"use client";

import {
  getOverlayEntry,
  isOverlayActive,
  toggleOverlay,
  useDirectionsStore,
  useNavigationStore,
} from "@openmapx/core";
import { useEffect, useMemo, useRef } from "react";

type OverlayContext = "transit-planning" | "transit-nav" | "driving-planning" | "driving-nav";

/**
 * Overlays that switch on automatically for a given trip context and switch back
 * to the user's prior choice when the context ends. Extending is one entry: the
 * overlay's id (as registered in the overlay registry) and the contexts it
 * belongs to. A manual toggle is never overridden — an overlay the user already
 * enabled stays on when the context ends, and one they turn off mid-context is
 * left off.
 */
const CONTEXTUAL_OVERLAYS: Array<{ overlayId: string; contexts: OverlayContext[] }> = [
  // Live vehicles + the static transit-line map, while planning or riding transit.
  { overlayId: "live-transit", contexts: ["transit-planning", "transit-nav"] },
  { overlayId: "transit", contexts: ["transit-planning", "transit-nav"] },
  // Traffic incidents + flow, while planning or driving a car/motorcycle route.
  { overlayId: "road-conditions", contexts: ["driving-planning", "driving-nav"] },
  { overlayId: "traffic-flow", contexts: ["driving-planning", "driving-nav"] },
];

const DRIVING_MODES = new Set(["driving", "motorcycle"]);

/**
 * Drives {@link CONTEXTUAL_OVERLAYS} through the overlay registry (the same
 * `toggleOverlay` path the layer selector uses, so overlays read as enabled and
 * stay user-disableable), enabling the mapped overlays while the user is planning
 * or navigating a matching context and restoring their prior choice on exit.
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

  // Overlays this mechanism turned on, so it only turns back off the ones it
  // enabled (never a manual toggle).
  const autoEnabledRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    for (const { overlayId, contexts } of CONTEXTUAL_OVERLAYS) {
      // Skip overlays whose integration isn't registered on this deployment.
      if (!getOverlayEntry(overlayId)) continue;
      const want = contexts.some((context) => active.has(context));
      const enabled = isOverlayActive(overlayId);
      if (want && !enabled) {
        toggleOverlay(overlayId);
        autoEnabledRef.current.add(overlayId);
      } else if (!want && autoEnabledRef.current.has(overlayId)) {
        if (enabled) toggleOverlay(overlayId);
        autoEnabledRef.current.delete(overlayId);
      }
    }
  }, [active]);

  return null;
}
