"use client";

import { useNavigationStore } from "@openmapx/core";
import type { ReactNode } from "react";

/**
 * Hides its children while live navigation is active (status !== "idle").
 * Used to clear the map chrome (search bar, category chips, weather, account
 * avatar) during turn-by-turn navigation, mirroring Google Maps' nav layout.
 */
export function HideDuringNavigation({ children }: { children: ReactNode }) {
  const navigating = useNavigationStore((s) => s.status !== "idle");
  if (navigating) return null;
  return <>{children}</>;
}
