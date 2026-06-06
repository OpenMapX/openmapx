"use client";

import { useNavigationStore, useSidebarStore } from "@openmapx/core";
import { useEffect } from "react";
import { PANEL_WIDTH } from "@/lib/layout";

// Pixels to lift the bottom-right attribution while navigating, so it clears
// the navigation bottom sheet instead of hiding behind it.
const NAV_ATTRIB_LIFT = 96;

/**
 * Drives the `--omx-attrib-shift` and `--omx-attrib-bottom` CSS variables for
 * MapLibre's built-in AttributionControl. When the (left) sidebar is open and
 * not collapsed, the attribution's available width shrinks by `PANEL_WIDTH` so
 * its text can't extend left under the panel. While navigating, it is lifted
 * above the bottom sheet. The control itself stays anchored to the right edge;
 * matching CSS lives in `app/globals.css`.
 */
export function MapAttributionPositioner(): null {
  const sidebarOpen = useSidebarStore((s) => s.activeSidebarId !== null);
  const sidebarCollapsed = useSidebarStore((s) => s.collapsed);
  const navigating = useNavigationStore((s) => s.status !== "idle");
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

  useEffect(() => {
    const value = navigating ? `${NAV_ATTRIB_LIFT}px` : "0px";
    document.documentElement.style.setProperty("--omx-attrib-bottom", value);
    return () => {
      document.documentElement.style.setProperty("--omx-attrib-bottom", "0px");
    };
  }, [navigating]);

  return null;
}
