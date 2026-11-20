"use client";

import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import { formatDuration, formatOverviewDistance, type Route, type Waypoint } from "@openmapx/core";
import { useLocale, useTranslations } from "next-intl";
import { ClickableRow } from "@/components/ui/ClickableRow";
import { BRAND } from "@/integration-api/runtime/theme";
import { routeCardFrameSx } from "./routeCardChrome";

/**
 * A plain multi-stop trip's one route: its total and each leg between stops,
 * framed as the chosen route. A click anywhere opens its details; the Details
 * button is the keyboard path.
 */
export function MultiStopRouteSummary({
  route,
  waypoints,
  units,
  onDetails,
}: {
  route: Route;
  waypoints: readonly Waypoint[];
  units: "metric" | "imperial";
  onDetails: () => void;
}) {
  const t = useTranslations("directions");
  const tc = useTranslations("common");
  const locale = useLocale();
  return (
    <Box>
      {/* Pointer shortcut for the Details button below, the keyboard path. */}
      {/* biome-ignore lint/plugin/noClickableLayoutElement: duplicates the Details button */}
      <Box sx={routeCardFrameSx(true)} onClick={onDetails}>
        <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
          <Typography variant="body2" sx={{ fontWeight: 600, color: "text.primary" }}>
            {formatDuration(route.duration, locale)}
          </Typography>
          <Typography variant="body2" sx={{ color: "text.secondary" }}>
            {formatOverviewDistance(route.distance, units)}
          </Typography>
        </Box>
        {route.legs.length > 1 && (
          <Box sx={{ mt: 1 }}>
            {route.legs.map((leg, i) => {
              const fromLabel = waypoints[i]?.label || t("origin");
              const toLabel = waypoints[i + 1]?.label || t("destination");
              return (
                <Typography
                  // biome-ignore lint/suspicious/noArrayIndexKey: legs have no stable id
                  key={i}
                  variant="caption"
                  sx={{ color: "text.secondary", display: "block", lineHeight: 1.6 }}
                >
                  {fromLabel}→ {toLabel}
                  {" · "}
                  {formatDuration(leg.duration, locale)}
                  {" · "}
                  {formatOverviewDistance(leg.distance, units)}
                </Typography>
              );
            })}
          </Box>
        )}
        <Box sx={{ mt: 0.5, ml: -1.5 }}>
          <ClickableRow
            sx={{
              width: "auto",
              typography: "caption",
              color: BRAND,
              fontWeight: 500,
              px: 1.5,
              py: 0.75,
              borderRadius: 99,
              "&:hover": { bgcolor: `${BRAND}18` },
              transition: "background-color 0.15s",
            }}
            onClick={(e) => {
              e.stopPropagation();
              onDetails();
            }}
          >
            {tc("details")}
          </ClickableRow>
        </Box>
      </Box>
    </Box>
  );
}
