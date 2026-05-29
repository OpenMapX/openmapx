"use client";

import Typography from "@mui/material/Typography";
import type { ReactNode } from "react";

/**
 * Uppercase, letter-spaced caption used as an in-panel section header
 * (e.g. "Runways", today/tomorrow tide schedules). Renders the exact
 * Typography these sections hand-rolled so output is byte-identical.
 */
export function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <Typography
      variant="caption"
      sx={{
        color: "text.secondary",
        fontWeight: 600,
        letterSpacing: 0.4,
        textTransform: "uppercase",
      }}
    >
      {children}
    </Typography>
  );
}
