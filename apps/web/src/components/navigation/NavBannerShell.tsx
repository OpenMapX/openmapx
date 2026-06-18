"use client";

import Box from "@mui/material/Box";
import type { ReactNode } from "react";

/**
 * Shared turn-by-turn banner shell: a rounded, primary-colored card with a
 * leading icon/badge, a main text block, and an optional darkened sub-row for a
 * secondary preview line.
 *
 * Used by both the driving {@link ManeuverBanner} (its "Then …" preview) and the
 * transit {@link TransitLegBanner} (its next-stop preview) so the two stay
 * visually identical — change the look here once and both follow.
 */
export function NavBannerShell({
  leading,
  children,
  secondary,
}: {
  leading: ReactNode;
  children: ReactNode;
  secondary?: ReactNode;
}) {
  return (
    <Box
      role="status"
      aria-live="polite"
      sx={{
        bgcolor: "primary.main",
        color: "primary.contrastText",
        borderRadius: 3,
        overflow: "hidden",
      }}
    >
      <Box sx={{ display: "flex", alignItems: "center", gap: 2, p: 2 }}>
        {leading}
        <Box sx={{ minWidth: 0 }}>{children}</Box>
      </Box>
      {secondary != null && (
        <Box
          sx={{
            display: "flex",
            alignItems: "center",
            gap: 1,
            px: 2,
            py: 1,
            bgcolor: "rgba(0, 0, 0, 0.18)",
          }}
        >
          {secondary}
        </Box>
      )}
    </Box>
  );
}
