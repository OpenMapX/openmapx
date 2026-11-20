"use client";

import type { LngLat, Waypoint } from "@openmapx/core";
import {
  CALLER_SHOWS_ERRORS,
  useDirectionsStore,
  useOptimizeRoute,
  useSettingsStore,
} from "@openmapx/core";
import { useTranslations } from "next-intl";
import { useShallow } from "zustand/react/shallow";

/** Whether two itineraries hold the same stops, at the same places, in the same order. */
function sameStops(a: readonly Waypoint[], b: readonly Waypoint[]): boolean {
  return (
    a.length === b.length &&
    a.every(
      (wp, i) =>
        wp.id === b[i]?.id &&
        wp.coords?.[0] === b[i]?.coords?.[0] &&
        wp.coords?.[1] === b[i]?.coords?.[1],
    )
  );
}

/**
 * Asks for the shortest order of a trip's stops and applies it. The caller must
 * stay mounted while details views replace the main view, so an answer that
 * lands while the user reads a route's details still applies.
 */
export function useOptimizeStops(routeWaypoints: LngLat[], onNotify: (message: string) => void) {
  const t = useTranslations("directions");
  const routeOptions = useDirectionsStore(
    useShallow((s) => ({
      avoidHighways: s.avoidHighways,
      avoidTolls: s.avoidTolls,
      avoidFerries: s.avoidFerries,
      bikeProfile: s.bikeProfile,
      bikeHillPreference: s.bikeHillPreference,
      bikePreferQuietRoads: s.bikePreferQuietRoads,
      bikePreferSmoothSurfaces: s.bikePreferSmoothSurfaces,
      bikeSpeedKmh: s.bikeSpeedKmh,
    })),
  );
  const units = useSettingsStore((s) => s.units);
  const optimizeMutation = useOptimizeRoute(CALLER_SHOWS_ERRORS);

  const optimize = () => {
    if (routeWaypoints.length < 3) return;
    const { waypoints: requestedStops, mode } = useDirectionsStore.getState();
    optimizeMutation.mutate(
      { waypoints: routeWaypoints, mode, ...routeOptions, units },
      {
        onSuccess: (result) => {
          if (!result.optimizedOrder) return;
          const directions = useDirectionsStore.getState();
          // The order answers the stops as they were when asked. If the user
          // moved, replaced or reordered a stop since, it no longer applies.
          if (!sameStops(requestedStops, directions.waypoints)) return;
          // Moves each waypoint whole, so a stop's dwell travels with it.
          onNotify(
            directions.applyWaypointOrder(result.optimizedOrder)
              ? t("routeOptimized")
              : t("scheduleOptimizeBlocked"),
          );
        },
        onError: () => onNotify(t("noRoutesFound")),
      },
    );
  };

  return { optimize, isPending: optimizeMutation.isPending };
}
