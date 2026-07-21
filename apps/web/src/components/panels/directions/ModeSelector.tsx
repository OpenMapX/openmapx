"use client";

import DirectionsBikeIcon from "@mui/icons-material/DirectionsBike";
import DirectionsBusIcon from "@mui/icons-material/DirectionsBus";
import DirectionsCarIcon from "@mui/icons-material/DirectionsCar";
import DirectionsWalkIcon from "@mui/icons-material/DirectionsWalk";
import EvStationIcon from "@mui/icons-material/EvStation";
import FlightIcon from "@mui/icons-material/Flight";
import TwoWheelerIcon from "@mui/icons-material/TwoWheeler";
import Box from "@mui/material/Box";
import CircularProgress from "@mui/material/CircularProgress";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import type { TravelMode } from "@openmapx/core";
import type { ReactNode } from "react";
import { TEAL } from "@/lib/theme";

const MODES: { mode: TravelMode; icon: ReactNode; labelKey: string; disabled?: boolean }[] = [
  { mode: "driving", icon: <DirectionsCarIcon sx={{ fontSize: 22 }} />, labelKey: "driving" },
  {
    mode: "transit",
    icon: <DirectionsBusIcon sx={{ fontSize: 22 }} />,
    labelKey: "transit",
  },
  { mode: "walking", icon: <DirectionsWalkIcon sx={{ fontSize: 22 }} />, labelKey: "walking" },
  { mode: "cycling", icon: <DirectionsBikeIcon sx={{ fontSize: 22 }} />, labelKey: "cycling" },
  { mode: "motorcycle", icon: <TwoWheelerIcon sx={{ fontSize: 22 }} />, labelKey: "motorcycle" },
  { mode: "flying", icon: <FlightIcon sx={{ fontSize: 22 }} />, labelKey: "flights" },
];

/**
 * Separate EV entry, rendered alongside the mapped `MODES` buttons. `"ev"` is
 * deliberately NOT a `TravelMode` (see `DirectionsState.isEvMode`) — it exists
 * only so the mode row can render an EV button next to the real `MODES`
 * entries. Selecting it sets `isEvMode` in the directions store instead of
 * changing `mode`.
 */
export const EV_MODE = {
  icon: <EvStationIcon sx={{ fontSize: 22 }} />,
  labelKey: "evMode",
} as const;

function ModeButton({
  icon,
  label,
  time,
  active,
  disabled,
  loading,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  time?: string;
  active: boolean;
  disabled?: boolean;
  loading?: boolean;
  onClick: () => void;
}) {
  return (
    <Tooltip title={label} placement="bottom" arrow>
      <Box
        onClick={disabled ? undefined : onClick}
        sx={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 0.4,
          px: 0.5,
          py: 0.5,
          cursor: disabled ? "default" : "pointer",
          opacity: disabled ? 0.35 : 1,
          borderRadius: 1,
          "&:hover": {},
          // Keep the 44px touch-target floor; don't squish inside the
          // horizontally-scrollable mode row.
          minWidth: 44,
          flexShrink: 0,
        }}
      >
        {/* Icon inside pill */}
        <Box
          sx={{
            px: 1,
            height: 32,
            borderRadius: 99,
            bgcolor: active ? "var(--omx-teal-light)" : "background.paper",
            // `action.hover` is translucent — using it as the full bgcolor
            // would let the panel background show through and make the pill
            // disappear. Use the opaque theme-aware chip hover.
            "&:hover": active ? {} : { bgcolor: "var(--omx-chip-hover)" },
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            transition: "background-color 0.15s",
            "& svg": {
              fontSize: 22,
              color: "text.primary",
              transition: "color 0.15s",
            },
          }}
        >
          {icon}
        </Box>

        {/* Time label below icon */}
        <Box sx={{ height: 14, display: "flex", alignItems: "center" }}>
          {loading ? (
            <CircularProgress size={10} sx={{ color: "text.disabled" }} />
          ) : (
            <Typography
              variant="caption"
              sx={{
                fontSize: 11,
                lineHeight: 1,
                color: active ? TEAL : "text.secondary",
                fontWeight: 600,
                whiteSpace: "nowrap",
                overflow: "hidden",
                maxWidth: 44,
                textOverflow: "ellipsis",
              }}
            >
              {time ?? ""}
            </Typography>
          )}
        </Box>
      </Box>
    </Tooltip>
  );
}

export { MODES, ModeButton };
