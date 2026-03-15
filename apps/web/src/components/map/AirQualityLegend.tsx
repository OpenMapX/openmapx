"use client";

import Box from "@mui/material/Box";
import LinearProgress from "@mui/material/LinearProgress";
import Paper from "@mui/material/Paper";
import Switch from "@mui/material/Switch";
import Typography from "@mui/material/Typography";
import { useAirQualityStore } from "@openmapx/core";

const AQI_LEVELS = [
  { label: "Good", color: "#009966" },
  { label: "Moderate", color: "#ffde33" },
  { label: "Unhealthy\nfor some", color: "#ff9933" },
  { label: "Unhealthy", color: "#cc0033" },
  { label: "Very\nunhealthy", color: "#660099" },
  { label: "Hazardous", color: "#7e0023" },
] as const;

export function AirQualityLegend() {
  const panelOpen = useAirQualityStore((s) => s.panelOpen);
  const layerVisible = useAirQualityStore((s) => s.layerVisible);
  const loading = useAirQualityStore((s) => s.loading);
  const setLayerVisible = useAirQualityStore((s) => s.setLayerVisible);

  if (!panelOpen) return null;

  return (
    <Paper
      elevation={3}
      sx={{
        position: "absolute",
        bottom: 16,
        left: "50%",
        transform: "translateX(-50%)",
        zIndex: 10,
        px: 2,
        py: 1.5,
        borderRadius: "12px",
        whiteSpace: "nowrap",
        overflow: "hidden",
      }}
    >
      {loading && (
        <LinearProgress
          sx={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            height: 2,
            borderRadius: "12px 12px 0 0",
          }}
        />
      )}

      <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", mb: 1 }}>
        <Typography sx={{ fontWeight: 600, fontSize: 14 }}>Air Quality Index</Typography>
        <Switch
          size="small"
          checked={layerVisible}
          onChange={(e) => setLayerVisible(e.target.checked)}
          inputProps={{ "aria-label": "Toggle air quality overlay" }}
          sx={{ ml: 2 }}
        />
      </Box>

      <Box sx={{ display: "flex", flexDirection: "row", gap: 1.5 }}>
        {AQI_LEVELS.map((level) => (
          <Box
            key={level.label}
            sx={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 0.5 }}
          >
            <Box sx={{ width: 32, height: 16, borderRadius: "3px", bgcolor: level.color }} />
            <Typography
              sx={{ fontSize: 10, textAlign: "center", lineHeight: 1.25, whiteSpace: "pre-line" }}
            >
              {level.label}
            </Typography>
          </Box>
        ))}
      </Box>

      <Typography sx={{ fontSize: 10.5, color: "text.secondary", mt: 0.75 }}>
        Air Quality Index (PM2.5) ·{" "}
        <a href="https://openaq.org" target="_blank" rel="noreferrer" style={{ color: "inherit" }}>
          OpenAQ
        </a>{" "}
        (
        <a
          href="https://creativecommons.org/licenses/by/4.0/"
          target="_blank"
          rel="noreferrer"
          style={{ color: "inherit" }}
        >
          CC BY 4.0
        </a>
        )
      </Typography>
    </Paper>
  );
}
