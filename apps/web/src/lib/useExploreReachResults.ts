"use client";

import {
  pointInIsochroneGeometry,
  useCategorySearchStore,
  useExploreResults,
  useIsochrone,
} from "@openmapx/core";
import { useMemo } from "react";

/**
 * useExploreResults plus the "only within reach" filter: when travel-time is
 * enabled with onlyWithinReach, results outside the isochrone contour are
 * removed from `filtered`. Shares the isochrone request with the overlay layer
 * (identical useIsochrone params dedupe in TanStack Query).
 */
export function useExploreReachResults(lang?: string) {
  const base = useExploreResults(lang);
  const anchor = useCategorySearchStore((s) => s.anchor);
  const travelTime = useCategorySearchStore((s) => s.travelTime);

  const reachActive = travelTime.enabled && travelTime.onlyWithinReach && anchor !== null;

  const { data: isochroneData } = useIsochrone({
    origin: anchor?.coordinates ?? null,
    mode: travelTime.mode,
    contourMinutes: [travelTime.minutes],
    enabled: travelTime.enabled && anchor !== null,
  });

  const filtered = useMemo(() => {
    if (!reachActive || !base.filtered) return base.filtered;
    const contour = isochroneData?.contours[0];
    if (!contour) return base.filtered;
    return base.filtered.filter((p) => pointInIsochroneGeometry(p.coordinates, contour.geometry));
  }, [reachActive, base.filtered, isochroneData]);

  return { ...base, filtered };
}
