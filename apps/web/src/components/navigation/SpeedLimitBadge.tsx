"use client";

import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";

interface Props {
  speedLimit: number | null; // km/h
  units: "metric" | "imperial";
  /** Highlight as a warning when the driver is exceeding the limit. */
  over?: boolean;
  /** Diameter in CSS pixels; the car screen draws it larger than the phone. */
  size?: number;
}

export function SpeedLimitBadge({ speedLimit, units, over = false, size = 56 }: Props) {
  if (speedLimit === null) return null;
  const value = units === "imperial" ? Math.round(speedLimit / 1.609) : speedLimit;
  return (
    <Box
      aria-label={over ? "Over the speed limit" : undefined}
      sx={{
        width: size,
        height: size,
        borderRadius: "50%",
        bgcolor: over ? "#d32f2f" : "#fff",
        border: `${Math.round(size / 11)}px solid #d32f2f`,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        transition: "background-color 150ms ease",
      }}
    >
      <Typography
        sx={{ color: over ? "#fff" : "#000", fontWeight: 700, fontSize: Math.round(size * 0.36) }}
      >
        {value}
      </Typography>
    </Box>
  );
}
