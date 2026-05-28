"use client";

import { useTravelTimeStore } from "@integrations/overlay-tool-travel-time/store";
import { pointInIsochroneGeometry, useExploreResults, useIsochrone } from "@openmapx/core";
import { useMemo } from "react";

/**
 * useExploreResults plus the "only within reach" filter. When the shared
 * travel-time tool is active in anchored mode with onlyWithinReach, results
 * outside the outermost isochrone contour are removed from `filtered`. Shares
 * the isochrone request with the overlay layer (identical useIsochrone params
 * dedupe in TanStack Query).
 */
export function useExploreReachResults(lang?: string) {
  const base = useExploreResults(lang);
  const isActive = useTravelTimeStore((s) => s.isActive);
  const anchored = useTravelTimeStore((s) => s.anchored);
  const onlyWithinReach = useTravelTimeStore((s) => s.onlyWithinReach);
  const origin = useTravelTimeStore((s) => s.origin);
  const mode = useTravelTimeStore((s) => s.mode);
  const selectedMinutes = useTravelTimeStore((s) => s.selectedMinutes);

  const ttActive = isActive && anchored && origin !== null;
  const reachActive = ttActive && onlyWithinReach;

  const { data: isochroneData } = useIsochrone({
    origin,
    mode,
    contourMinutes: selectedMinutes,
    enabled: ttActive,
  });

  const filtered = useMemo(() => {
    if (!reachActive || !base.filtered) return base.filtered;
    // Filter by the outermost (largest-time) contour — "within reach" means
    // reachable within the most generous selected threshold.
    const outer = isochroneData?.contours.reduce(
      (max, c) => (max && max.time >= c.time ? max : c),
      isochroneData.contours[0],
    );
    if (!outer) return base.filtered;
    return base.filtered.filter((p) => pointInIsochroneGeometry(p.coordinates, outer.geometry));
  }, [reachActive, base.filtered, isochroneData]);

  return { ...base, filtered };
}
