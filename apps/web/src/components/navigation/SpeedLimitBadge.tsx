"use client";

import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";

interface Props {
  speedLimit: number | null; // km/h
  units: "metric" | "imperial";
  /** Highlight as a warning when the driver is exceeding the limit. */
  over?: boolean;
}

export function SpeedLimitBadge({ speedLimit, units, over = false }: Props) {
  if (speedLimit === null) return null;
  const value = units === "imperial" ? Math.round(speedLimit / 1.609) : speedLimit;
  return (
    <Box
      aria-label={over ? "Over the speed limit" : undefined}
      sx={{
        width: 56,
        height: 56,
        borderRadius: "50%",
        bgcolor: over ? "#d32f2f" : "#fff",
        border: "5px solid #d32f2f",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        transition: "background-color 150ms ease",
      }}
    >
      <Typography sx={{ color: over ? "#fff" : "#000", fontWeight: 700, fontSize: 20 }}>
        {value}
      </Typography>
    </Box>
  );
}
