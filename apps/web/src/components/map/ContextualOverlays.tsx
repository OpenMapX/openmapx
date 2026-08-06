"use client";

import {
  createContextualOverlayOwnership,
  getOverlayEntry,
  isLiveNavigationStatus,
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
 * left off, even if the value they set happens to match what automation had.
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

let contextualSessionSeq = 0;

/**
 * Drives {@link CONTEXTUAL_OVERLAYS} through the overlay registry's
 * transaction API (the same runOverlayTransaction path the layer selector's
 * toggleOverlay uses, so overlays read as enabled and stay user-disableable),
 * enabling the mapped overlays while the user is planning or navigating a
 * matching context and restoring their prior choice — including any
 * exclusion peer it displaced — on context exit, on a teardown mid-context,
 * or when two contexts both wanted the same overlay and only one has let go.
 * isLiveNavigationStatus deliberately excludes "arrived": the arrival card
 * and session summary stay on screen after arrival, but contextual
 * automation ends with the live navigation it was driven by, not the
 * lingering summary.
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
    const navigating = isLiveNavigationStatus(navStatus);
    if (navigating && navKind === "transit") set.add("transit-nav");
    if (navigating && navKind === "ground" && DRIVING_MODES.has(navMode)) set.add("driving-nav");
    return set;
  }, [directionsOpen, directionsMode, navKind, navMode, navStatus]);

  // One ownership session per mount. Each CONTEXTUAL_OVERLAYS row is its own
  // refcounted owner (keyed by array index, not overlayId, so two rows that
  // ever named the same overlay wouldn't collapse into a single owner) — the
  // tracker itself only releases an overlay once every row that wanted it has
  // let go, so a driving-planning -> driving-nav transition that keeps the
  // same overlay wanted the whole time never dips through a release+reacquire.
  const ownershipRef = useRef<ReturnType<typeof createContextualOverlayOwnership> | null>(null);
  if (!ownershipRef.current) {
    contextualSessionSeq += 1;
    ownershipRef.current = createContextualOverlayOwnership(
      `contextual-overlays:${contextualSessionSeq}`,
    );
  }
  const ownership = ownershipRef.current;

  useEffect(() => {
    CONTEXTUAL_OVERLAYS.forEach(({ overlayId, contexts }, index) => {
      // Skip overlays whose integration isn't registered on this deployment.
      if (!getOverlayEntry(overlayId)) return;
      const ownerKey = String(index);
      const want = contexts.some((context) => active.has(context));
      if (want) {
        ownership.acquire(overlayId, ownerKey);
      } else {
        ownership.release(overlayId, ownerKey);
      }
    });
  }, [active, ownership]);

  // A teardown mid-context must not leave an auto-enabled overlay on. This is
  // its own effect — with no dependency that ever changes across the
  // component's lifetime — so its cleanup fires only on unmount, not on every
  // `active` change the effect above already handles.
  useEffect(() => {
    return () => ownership.releaseAll();
  }, [ownership]);

  return null;
}
