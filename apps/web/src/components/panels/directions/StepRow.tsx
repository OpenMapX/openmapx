"use client";

import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import Box from "@mui/material/Box";
import Divider from "@mui/material/Divider";
import Typography from "@mui/material/Typography";
import { formatDistance, formatDuration } from "@openmapx/core";

export function StepRow({
  instruction,
  distance,
  duration,
  units,
}: {
  instruction: string;
  distance: number;
  duration: number;
  units: "metric" | "imperial";
}) {
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
        <Box sx={{ flex: 1 }}>
          <Typography variant="body2">{instruction}</Typography>
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
