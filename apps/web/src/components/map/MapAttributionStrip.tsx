"use client";

import Box from "@mui/material/Box";
import { useSidebarStore } from "@openmapx/core";
import { useMemo } from "react";
import { AttributionStrip } from "@/components/ui/AttributionStrip";
import { PANEL_WIDTH } from "@/lib/layout";
import { flattenAttributions, useMapAttributionStore } from "@/lib/mapAttributionStore";

/**
 * Floating attribution host. Renders `<AttributionStrip variant="footer">` at
 * the map's bottom-right corner, reading from `useMapAttributionStore`.
 *
 * Replaces MapLibre's built-in `AttributionControl` so the app has a single
 * React-driven attribution rendering path. Layer components register their
 * `Attribution[]` via `useRegisterMapAttribution` while mounted.
 */
export function MapAttributionStrip() {
  const entries = useMapAttributionStore((s) => s.entries);
  const sidebarOpen = useSidebarStore((s) => s.activeSidebarId !== null);
  const sidebarCollapsed = useSidebarStore((s) => s.collapsed);
  const shifted = sidebarOpen && !sidebarCollapsed;

  const attributions = useMemo(() => flattenAttributions(entries), [entries]);
  if (attributions.length === 0) return null;

  return (
    <Box
      sx={{
        position: "absolute",
        bottom: "var(--omx-safe-bottom)",
        right: "var(--omx-safe-right)",
        // Leave room for legends sitting bottom-center on small viewports;
        // on desktop the strip auto-wraps inside `maxWidth`.
        zIndex: 5,
        bgcolor: "color-mix(in srgb, var(--omx-overlay-bg) 50%, transparent)",
        backdropFilter: "blur(4px)",
        WebkitBackdropFilter: "blur(4px)",
        px: "5px",
        py: "2px",
        borderRadius: "3px",
        maxWidth: {
          xs: `calc(100vw - 2 * var(--omx-safe-right))`,
          sm: shifted
            ? `calc(100vw - ${PANEL_WIDTH}px - 32px)`
            : `calc(100vw - 2 * var(--omx-safe-right))`,
          md: "min(70vw, 600px)",
        },
        pointerEvents: "auto",
        transition: "max-width 0.25s ease",
      }}
      data-testid="map-attribution-strip"
    >
      <AttributionStrip variant="footer" attributions={attributions} />
    </Box>
  );
}
