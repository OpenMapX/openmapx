"use client";

import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import Box from "@mui/material/Box";
import Divider from "@mui/material/Divider";
import Typography from "@mui/material/Typography";
import {
  formatDistance,
  formatDuration,
  type ManeuverLane,
  type ManeuverSign,
} from "@openmapx/core";
import { LaneGuidance } from "@/components/navigation/LaneGuidance";
import { ExitSignStrip } from "@/components/navigation/signs/ExitSignStrip";

interface StepRowProps {
  instruction: string;
  distance: number;
  duration: number;
  units: "metric" | "imperial";
  /** Turn-lane guidance for this step, when the engine supplies it. */
  lanes?: ManeuverLane[];
  /** Normalized maneuver for the lane recommendation fallback. */
  maneuver?: { type: string; modifier?: string };
  /** Interchange signage for this step, when the engine supplies it. */
  sign?: ManeuverSign;
  /** Country of the route origin, for the sign palette. */
  country?: string | null;
}

export function StepRow({
  instruction,
  distance,
  duration,
  units,
  lanes,
  maneuver,
  sign,
  country,
}: StepRowProps) {
  const dist =
    units === "imperial" ? `${(distance / 1609.34).toFixed(1)} mi` : formatDistance(distance);

  return (
    <Box>
      <Box
        sx={{
          display: "flex",
          alignItems: "flex-start",
          gap: 1.5,
          px: 2,
          py: 1,
        }}
      >
        <Box sx={{ flexShrink: 0, color: "text.secondary", mt: 0.25 }}>
          <ChevronRightIcon sx={{ fontSize: 18 }} />
        </Box>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          {sign && <ExitSignStrip sign={sign} country={country} size="compact" />}
          <Typography variant="body2">{instruction}</Typography>
          {lanes && lanes.length > 0 && (
            <LaneGuidance variant="standalone" size="compact" lanes={lanes} maneuver={maneuver} />
          )}
        </Box>
      </Box>
      <Box sx={{ pl: 6, pr: 2, pb: 0.5 }}>
        <Typography
          variant="caption"
          sx={{
            color: "text.secondary",
          }}
        >
          {formatDuration(duration)} ({dist})
        </Typography>
        <Divider sx={{ mt: 0.5 }} />
      </Box>
    </Box>
  );
}
