"use client";

import Box from "@mui/material/Box";
import Divider from "@mui/material/Divider";
import Typography from "@mui/material/Typography";
import {
  formatDuration,
  formatMeasurementDistance,
  type ManeuverLane,
  type ManeuverSign,
} from "@openmapx/core";
import { useLocale } from "next-intl";
import { LaneGuidance } from "@/components/navigation/LaneGuidance";
import { ExitSignStrip } from "@/components/navigation/signs/ExitSignStrip";
import { type Maneuver, maneuverIconFor } from "@/lib/navigation/maneuverIcon";

interface StepRowProps {
  instruction: string;
  distance: number;
  duration: number;
  units: "metric" | "imperial";
  /** Turn-lane guidance for this step, when the engine supplies it. */
  lanes?: ManeuverLane[];
  /** Normalized maneuver for the lane recommendation fallback. */
  maneuver?: Maneuver;
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
  const locale = useLocale();
  const dist = formatMeasurementDistance(distance, units);
  const ManeuverIcon = maneuverIconFor(maneuver ?? { type: "continue" }).component;

  return (
    <Box>
      <Box
        sx={{
          display: "flex",
          alignItems: "flex-start",
          gap: 2,
          px: 2,
          py: 1,
        }}
      >
        <Box sx={{ flexShrink: 0, display: "flex", color: "text.primary" }}>
          <ManeuverIcon aria-hidden sx={{ fontSize: 22 }} />
        </Box>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          {sign && <ExitSignStrip sign={sign} country={country} size="compact" />}
          <Typography variant="body2">{instruction}</Typography>
          {lanes && lanes.length > 0 && (
            <LaneGuidance variant="standalone" size="compact" lanes={lanes} maneuver={maneuver} />
          )}
        </Box>
      </Box>
      {/* Under the instruction text: 16px inset + the 22px icon + its 16px gap. */}
      <Box sx={{ pl: "54px", pr: 2, pb: 0.5 }}>
        <Typography
          variant="caption"
          sx={{
            color: "text.secondary",
          }}
        >
          {formatDuration(duration, locale)} ({dist})
        </Typography>
        <Divider sx={{ mt: 0.5 }} />
      </Box>
    </Box>
  );
}
