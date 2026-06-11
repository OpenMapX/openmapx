"use client";

import AutoAwesomeIcon from "@mui/icons-material/AutoAwesome";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import { TEAL } from "@/lib/theme";

export function AiBadge({ label = "AI" }: { label?: string }) {
  return (
    <Box sx={{ display: "inline-flex", alignItems: "center", gap: 0.5, color: TEAL }}>
      <AutoAwesomeIcon sx={{ fontSize: 16 }} />
      <Typography variant="caption" sx={{ fontWeight: 600 }}>
        {label}
      </Typography>
    </Box>
  );
}
