"use client";

import { useSidebarStore } from "@openmapx/core";
import { useEffect } from "react";
import { PANEL_WIDTH } from "@/lib/layout";

/**
 * Drives the `--omx-attrib-shift` CSS variable that positions MapLibre's
 * built-in AttributionControl. When the sidebar is open (and not collapsed),
 * the attribution strip shifts left by `PANEL_WIDTH` so it doesn't end up
 * under the panel. The matching CSS lives in `app/globals.css`.
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
      // and leave the attribution control shifted on any future map mount
      // that no longer has a positioner driving it.
      document.documentElement.style.setProperty("--omx-attrib-shift", "0px");
    };
  }, [shifted]);

  return null;
}
