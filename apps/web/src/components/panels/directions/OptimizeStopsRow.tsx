"use client";

import RouteIcon from "@mui/icons-material/Route";
import Box from "@mui/material/Box";
import CircularProgress from "@mui/material/CircularProgress";
import Typography from "@mui/material/Typography";
import type { LngLat, Waypoint } from "@openmapx/core";
import {
  CALLER_SHOWS_ERRORS,
  useDirectionsStore,
  useOptimizeRoute,
  useSettingsStore,
} from "@openmapx/core";
import { useTranslations } from "next-intl";
import { useShallow } from "zustand/react/shallow";
import { BRAND } from "@/integration-api/runtime/theme";

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

/** Modes whose route someone else drives, or that the optimize engine does not plan. */
const UNOPTIMIZED_MODES = new Set(["transit", "flying", "ride"]);

interface OptimizeStopsRowProps {
  /** The placed stops' coordinates, as the route plan sends them. */
  routeWaypoints: LngLat[];
  allWaypointsFilled: boolean;
  onNotify: (message: string) => void;
}

/**
 * Reorders a trip's stops for the shortest route. It stays mounted while
 * hidden, so an answer that arrives after the row hides still applies.
 */
export function OptimizeStopsRow({
  routeWaypoints,
  allWaypointsFilled,
  onNotify,
}: OptimizeStopsRowProps) {
  const t = useTranslations("directions");
  const waypoints = useDirectionsStore((s) => s.waypoints);
  const mode = useDirectionsStore((s) => s.mode);
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

  const handleOptimize = () => {
    if (routeWaypoints.length < 3) return;
    const requestedStops = waypoints;
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

  if (waypoints.length <= 2 || !allWaypointsFilled || UNOPTIMIZED_MODES.has(mode)) return null;

  // Reordering could move a stop past its appointment, and the optimize engine
  // has no notion of time windows, so it is refused rather than silently wrong.
  const blocked = waypoints.some(
    (wp) =>
      wp.schedule?.departAfter !== undefined ||
      wp.schedule?.arriveBy !== undefined ||
      wp.schedule?.fixedAt !== undefined,
  );
  return (
    <Box
      sx={{
        display: "flex",
        alignItems: "center",
        gap: 1,
        px: 2,
        py: 0.75,
        borderBottom: "1px solid",
        borderColor: "divider",
      }}
    >
      <Typography
        component="button"
        type="button"
        variant="body2"
        onClick={handleOptimize}
        disabled={blocked}
        title={blocked ? t("scheduleOptimizeBlocked") : undefined}
        sx={{
          color: blocked ? "text.disabled" : BRAND,
          cursor: blocked ? "not-allowed" : "pointer",
          fontWeight: 500,
          display: "inline-flex",
          alignItems: "center",
          gap: 0.75,
          px: 1.5,
          py: 0.5,
          border: "none",
          background: "none",
          font: "inherit",
          borderRadius: 99,
          "&:hover": { bgcolor: blocked ? "transparent" : `${BRAND}18` },
          transition: "background-color 0.15s",
        }}
      >
        {optimizeMutation.isPending ? (
          <>
            <CircularProgress size={14} sx={{ color: BRAND }} />
            {t("optimizing")}
          </>
        ) : (
          <>
            <RouteIcon sx={{ fontSize: 16 }} />
            {t("optimizeStopOrder")}
          </>
        )}
      </Typography>
    </Box>
  );
}
