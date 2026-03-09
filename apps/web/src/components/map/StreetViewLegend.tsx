"use client";

import Box from "@mui/material/Box";
import Paper from "@mui/material/Paper";
import Switch from "@mui/material/Switch";
import Typography from "@mui/material/Typography";
import { useStreetViewStore } from "@openmapx/core";

export function StreetViewLegend() {
  const panelOpen = useStreetViewStore((s) => s.panelOpen);
  const coverageVisible = useStreetViewStore((s) => s.coverageVisible);
  const setCoverageVisible = useStreetViewStore((s) => s.setCoverageVisible);

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
      }}
    >
      <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", mb: 1 }}>
        <Typography sx={{ fontWeight: 600, fontSize: 14 }}>Coverage</Typography>
        <Switch
          size="small"
          checked={coverageVisible}
          onChange={(e) => setCoverageVisible(e.target.checked)}
          inputProps={{ "aria-label": "Toggle Street-level imagery coverage" }}
        />
      </Box>

      <Box sx={{ display: "flex", flexDirection: "row", gap: 2 }}>
        <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
          <Box sx={{ width: 24, height: 3, bgcolor: "#03a9f4", borderRadius: "2px" }} />
          <Typography sx={{ fontSize: 12 }}>Street-level imagery</Typography>
        </Box>
        <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
          <Box sx={{ width: 24, height: 0, borderBottom: "2px dashed #03a9f4" }} />
          <Typography sx={{ fontSize: 12 }}>Photo sequence</Typography>
        </Box>
        <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
          <Box
            sx={{
              width: 12,
              height: 12,
              border: "2px solid #03a9f4",
              borderRadius: "50%",
              bgcolor: "rgba(3,169,244,0.15)",
              flexShrink: 0,
            }}
          />
          <Typography sx={{ fontSize: 12 }}>360° photo</Typography>
        </Box>
      </Box>
    </Paper>
  );
}
