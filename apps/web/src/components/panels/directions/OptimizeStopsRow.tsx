"use client";

import RouteIcon from "@mui/icons-material/Route";
import Box from "@mui/material/Box";
import CircularProgress from "@mui/material/CircularProgress";
import Typography from "@mui/material/Typography";
import type { TravelMode, Waypoint } from "@openmapx/core";
import { useTranslations } from "next-intl";
import { BRAND } from "@/integration-api/runtime/theme";

/** Modes whose route someone else drives, or that the optimize engine does not plan. */
const UNOPTIMIZED_MODES = new Set<TravelMode>(["transit", "flying", "ride"]);

interface OptimizeStopsRowProps {
  waypoints: readonly Waypoint[];
  mode: TravelMode;
  allWaypointsFilled: boolean;
  pending: boolean;
  onOptimize: () => void;
}

/** The button that reorders a trip's stops for the shortest route. */
export function OptimizeStopsRow({
  waypoints,
  mode,
  allWaypointsFilled,
  pending,
  onOptimize,
}: OptimizeStopsRowProps) {
  const t = useTranslations("directions");

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
        onClick={onOptimize}
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
        {pending ? (
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
