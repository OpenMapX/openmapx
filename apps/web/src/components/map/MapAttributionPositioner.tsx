"use client";

import { useSidebarStore } from "@openmapx/core";
import { useEffect } from "react";
import { PANEL_WIDTH } from "@/lib/layout";

/**
 * Drives the `--omx-attrib-shift` CSS variable that clips the max-width of
 * MapLibre's built-in AttributionControl. When the (left) sidebar is open
 * and not collapsed, the attribution's available width shrinks by
 * `PANEL_WIDTH` so its text can't extend left under the panel. The control
 * itself stays anchored to the right edge; matching CSS lives in
 * `app/globals.css`.
 */
export function MapAttributionPositioner(): null {
  const sidebarOpen = useSidebarStore((s) => s.activeSidebarId !== null);
  const sidebarCollapsed = useSidebarStore((s) => s.collapsed);
  const shifted = sidebarOpen && !sidebarCollapsed;

  useEffect(() => {
    const value = shifted ? `${PANEL_WIDTH}px` : "0px";
    document.documentElement.style.setProperty("--omx-attrib-shift", value);
    return () => {
      // Reset on unmount so the variable doesn't strand at a non-zero value
      // and leave the attribution control clipped on any future map mount
      // that no longer has a positioner driving it.
      document.documentElement.style.setProperty("--omx-attrib-shift", "0px");
    };
  }, [shifted]);

  return null;
}
