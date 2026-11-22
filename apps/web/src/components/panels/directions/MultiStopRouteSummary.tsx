"use client";

import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import {
  formatDuration,
  formatOverviewDistance,
  type RoadConditionRouteImpact,
  type Route,
  type Waypoint,
} from "@openmapx/core";
import { useLocale, useTranslations } from "next-intl";
import {
  isInteractiveCardTarget,
  RouteCardActions,
  RouteStartError,
  routeCardFrameSx,
} from "./routeCardChrome";
import { useGroundRouteStart } from "./useGroundRouteStart";

/**
 * A plain multi-stop trip's one route: its total and each leg between stops,
 * framed as the chosen route. Clicking the card body opens details; the
 * Details and Start buttons below are the keyboard actions.
 */
export function MultiStopRouteSummary({
  route,
  waypoints,
  units,
  provider,
  roadConditionImpact,
  onDetails,
}: {
  route: Route;
  waypoints: readonly Waypoint[];
  units: "metric" | "imperial";
  /** Integration id of the routing provider that served this route, for nav attribution. */
  provider?: string;
  roadConditionImpact?: RoadConditionRouteImpact;
  onDetails: () => void;
}) {
  const t = useTranslations("directions");
  const locale = useLocale();
  const { canStart, start, starting, startError } = useGroundRouteStart({
    route,
    waypoints,
    index: 0,
    provider,
    roadConditionImpact,
    units,
  });

  return (
    <Box>
      {/* Pointer shortcut for the Details button below; interactive descendants stay independent. */}
      {/* biome-ignore lint/plugin/noClickableLayoutElement: pointer shortcut for the Details button */}
      <Box
        sx={routeCardFrameSx(true)}
        onClick={(event) => {
          if (!isInteractiveCardTarget(event.target)) onDetails();
        }}
      >
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
        <RouteCardActions
          onDetails={onDetails}
          onStart={canStart ? () => void start() : undefined}
          startDisabled={starting}
        />
        <RouteStartError error={startError} />
      </Box>
    </Box>
  );
}
