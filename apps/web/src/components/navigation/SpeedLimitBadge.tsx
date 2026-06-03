"use client";

import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";

interface Props {
  speedLimit: number | null; // km/h
  units: "metric" | "imperial";
}

export function SpeedLimitBadge({ speedLimit, units }: Props) {
  if (speedLimit === null) return null;
  const value = units === "imperial" ? Math.round(speedLimit / 1.609) : speedLimit;
  return (
    <Box
      sx={{
        width: 56,
        height: 56,
        borderRadius: "50%",
        bgcolor: "#fff",
        border: "5px solid #d32f2f",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Typography sx={{ color: "#000", fontWeight: 700, fontSize: 20 }}>{value}</Typography>
    </Box>
  );
}
