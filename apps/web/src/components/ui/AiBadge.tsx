"use client";

import AutoAwesomeIcon from "@mui/icons-material/AutoAwesome";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import { BRAND } from "@/integration-api/runtime/theme";

export function AiBadge({ label = "AI" }: { label?: string }) {
  return (
    <Box sx={{ display: "inline-flex", alignItems: "center", gap: 0.5, color: BRAND }}>
      <AutoAwesomeIcon sx={{ fontSize: 16 }} />
      <Typography variant="caption" sx={{ fontWeight: 600 }}>
        {label}
      </Typography>
    </Box>
  );
}
