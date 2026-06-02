import { computeTransitProgress, type FixInput, useNavigationStore } from "@openmapx/core";
import { useCallback } from "react";
import { useMapOptional } from "@/lib/MapContext";
import { haptics } from "../haptics";
import { useWatchPosition } from "../useWatchPosition";

/**
 * Transit follow-along engine. Wires GPS fixes → computeTransitProgress →
 * navigationStore, recenters the map on the snapped position, and fires arrival
 * once the traveller nears the end of the final leg. There is NO rerouting —
 * the planned itinerary is fixed; this only reports where along it we are.
 */
export function useTransitNavigationEngine(): void {
  const map = useMapOptional()?.mapRef.current ?? null;

  const onFix = useCallback(
    (fix: FixInput) => {
      const store = useNavigationStore.getState();
      const { status, kind, itinerary } = store;
      if (status !== "navigating" || kind !== "transit" || !itinerary) return;

      const tp = computeTransitProgress(itinerary, fix.coords);
      store.applyTransitProgress(tp);

      if (map) {
        map.easeTo(
          { center: tp.snapped, zoom: Math.max(map.getZoom(), 15), duration: 350 },
          { programmatic: true },
        );
      }

      if (tp.arrived) {
        haptics.success();
        store.completeArrival();
      }
    },
    [map],
  );

  const active = useNavigationStore(
    (s) => s.status !== "idle" && s.status !== "arrived" && s.kind === "transit",
  );
  useWatchPosition(active, onFix);
}
