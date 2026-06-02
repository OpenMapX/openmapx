"use client";

import Box from "@mui/material/Box";
import type { ManeuverLane } from "@openmapx/core";
import { maneuverIconFor } from "@/lib/navigation/maneuverIcon";

const TO_MANEUVER: Record<string, { type: string; modifier?: string }> = {
  left: { type: "turn", modifier: "left" },
  right: { type: "turn", modifier: "right" },
  straight: { type: "turn", modifier: "straight" },
  "slight left": { type: "turn", modifier: "slight left" },
  "slight right": { type: "turn", modifier: "slight right" },
};

export function LaneGuidance({ lanes }: { lanes?: ManeuverLane[] }) {
  if (!lanes || lanes.length === 0) return null;
  return (
    <Box
      sx={{
        display: "flex",
        gap: 0.5,
        justifyContent: "center",
        p: 1,
        bgcolor: "background.paper",
        borderRadius: 2,
      }}
    >
      {lanes.map((lane, i) => {
        const ind = lane.indications[0] ?? "straight";
        const Icon = maneuverIconFor(TO_MANEUVER[ind]).component;
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: lanes have no stable id
          <Box key={i} data-valid={String(lane.valid)} sx={{ opacity: lane.valid ? 1 : 0.3 }}>
            <Icon fontSize="small" />
          </Box>
        );
      })}
    </Box>
  );
}
