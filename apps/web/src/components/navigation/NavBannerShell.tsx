"use client";

import Box from "@mui/material/Box";
import type { ReactNode } from "react";

/**
 * Shared turn-by-turn banner shell: a rounded, primary-colored card with a
 * leading icon/badge, a main text block, an optional trailing badge (e.g. the
 * compact "then" next-maneuver hint), and an optional darkened sub-row for a
 * secondary preview line.
 *
 * Driving and walking use the primary tone. Transit rides use a neutral surface
 * so the service badge and the next instruction carry the hierarchy.
 */
export function NavBannerShell({
  leading,
  children,
  secondary,
  trailing,
  tone = "primary",
}: {
  leading: ReactNode;
  children: ReactNode;
  secondary?: ReactNode;
  /** Optional element pinned to the right of the main row. */
  trailing?: ReactNode;
  tone?: "primary" | "surface";
}) {
  return (
    <Box
      role="status"
      aria-live="polite"
      sx={{
        bgcolor: tone === "surface" ? "background.paper" : "primary.main",
        color: tone === "surface" ? "text.primary" : "primary.contrastText",
        borderRadius: "28px",
        overflow: "hidden",
        ...(tone === "surface" && { boxShadow: 2 }),
      }}
    >
      <Box sx={{ display: "flex", alignItems: "center", gap: 2, p: 2 }}>
        {leading}
        <Box sx={{ minWidth: 0, flex: 1 }}>{children}</Box>
        {trailing}
      </Box>
      {secondary != null && (
        <Box
          sx={{
            display: "flex",
            alignItems: "center",
            gap: 1,
            px: 2,
            py: 1,
            ...(tone === "surface"
              ? { borderTop: "1px solid", borderColor: "divider", color: "text.secondary" }
              : { bgcolor: "rgba(0, 0, 0, 0.18)" }),
          }}
        >
          {secondary}
        </Box>
      )}
    </Box>
  );
}
