"use client";

import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import type { ReactNode } from "react";
import { BRAND } from "@/integration-api/runtime/theme";

/**
 * Heading of a section inside a detail panel ("About this place", "Nearby
 * transit"…). One size and weight for every section, as a real heading under
 * the panel's title, optionally led by a brand-coloured icon.
 */
export function PanelSectionTitle({
  children,
  icon,
  gutterBottom = true,
}: {
  children: ReactNode;
  icon?: ReactNode;
  gutterBottom?: boolean;
}) {
  return (
    <Typography
      component="h2"
      sx={{
        display: "flex",
        alignItems: "center",
        gap: 1,
        fontSize: 16,
        fontWeight: 600,
        lineHeight: 1.5,
        color: "text.primary",
        mb: gutterBottom ? 0.75 : 0,
      }}
    >
      {icon && (
        <Box component="span" sx={{ display: "flex", color: BRAND, "& svg": { fontSize: 20 } }}>
          {icon}
        </Box>
      )}
      {children}
    </Typography>
  );
}
