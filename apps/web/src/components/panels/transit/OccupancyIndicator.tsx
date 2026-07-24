"use client";

import AirlineSeatReclineNormalIcon from "@mui/icons-material/AirlineSeatReclineNormal";
import Tooltip from "@mui/material/Tooltip";
import type { OccupancyLevel } from "@openmapx/mobility-core/transit";
import { useTranslations } from "next-intl";
import { OCCUPANCY_COLOR, OCCUPANCY_KEY } from "@/lib/transitOccupancy";

/**
 * Crowding indicator — a seat icon coloured by occupancy level with a localized
 * tooltip. Shared by the departure list, trip detail and transit navigation so
 * the crowding cue reads the same everywhere. Pass `inheritColor` on a coloured
 * surface (e.g. the brand-coloured nav banner) to keep the icon legible.
 */
export function OccupancyIndicator({
  level,
  size = 18,
  inheritColor = false,
}: {
  level: OccupancyLevel;
  size?: number;
  inheritColor?: boolean;
}) {
  const t = useTranslations("transit");
  return (
    <Tooltip title={t(OCCUPANCY_KEY[level])} placement="left" arrow>
      <AirlineSeatReclineNormalIcon
        aria-label={t(OCCUPANCY_KEY[level])}
        sx={{
          fontSize: size,
          color: inheritColor ? "inherit" : OCCUPANCY_COLOR[level],
          flexShrink: 0,
        }}
      />
    </Tooltip>
  );
}
