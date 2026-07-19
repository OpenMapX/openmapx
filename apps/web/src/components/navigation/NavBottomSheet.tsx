"use client";

import Box from "@mui/material/Box";
import Paper from "@mui/material/Paper";
import type { ReactNode } from "react";

/**
 * Compact, bottom-anchored sheet that hosts the navigation summary on mobile.
 * It borrows the visual language of {@link MobileBottomSheet} — rounded top
 * corners, elevation, and a drag-handle pill — but is content-height rather
 * than a draggable multi-snap sheet, since the nav summary is a single fixed
 * row. Full-bleed to the screen edges and padded for the bottom safe area.
 */
export function NavBottomSheet({
  children,
  onToggle,
}: {
  children: ReactNode;
  /** Tapping the drag handle runs this (expand/collapse the nav menu). */
  onToggle?: () => void;
}) {
  return (
    <Paper
      elevation={6}
      sx={(theme) => ({
        pointerEvents: "auto",
        width: "100%",
        borderRadius: "16px 16px 0 0",
        boxShadow: 6,
        pb: "var(--omx-safe-bottom)",
        ...theme.applyStyles("dark", { bgcolor: "background.default" }),
      })}
    >
      <Box
        onClick={onToggle}
        sx={{
          display: "flex",
          justifyContent: "center",
          pt: 1,
          pb: 0.5,
          cursor: onToggle ? "pointer" : "default",
        }}
      >
        <Box sx={{ width: 36, height: 4, borderRadius: 2, bgcolor: "action.disabled" }} />
      </Box>
      {children}
    </Paper>
  );
}
