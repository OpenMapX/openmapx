"use client";

import Box from "@mui/material/Box";
import { isOverSpeed, useNavigationStore, useSettingsStore } from "@openmapx/core";
import { SpeedLimitBadge } from "./SpeedLimitBadge";

interface Props {
  isMobile: boolean;
  /** Live height of the fixed-position mobile sheet, to lift the badge above it. */
  sheetClearance: number;
}

/**
 * The speed-limit badge. `over` depends on the live `speedMps`, so this
 * subscribes to `progress` itself rather than taking it from a cold parent —
 * otherwise a fix that only nudges the speed (with the limit unchanged) would
 * still have to re-render whatever owns the layout around it.
 */
export function NavSpeedLimitSlot({ isMobile, sheetClearance }: Props) {
  const currentSpeedLimit = useNavigationStore((s) => s.currentSpeedLimit);
  const speedMps = useNavigationStore((s) => s.progress?.speedMps ?? 0);
  const units = useSettingsStore((s) => s.units);

  if (currentSpeedLimit === null) return null;

  return (
    <Box
      sx={{
        pointerEvents: "auto",
        alignSelf: "flex-start",
        pl: 2,
        pb: 1,
        // Lifts the badge above the fixed-position mobile sheet;
        // inert on desktop, where the panel stays in-flow below it
        // and the sheet (so this clearance) never mounts.
        mb: isMobile && sheetClearance > 0 ? `${sheetClearance}px` : 0,
      }}
    >
      <SpeedLimitBadge
        speedLimit={currentSpeedLimit}
        units={units}
        over={isOverSpeed(speedMps, currentSpeedLimit)}
      />
    </Box>
  );
}
