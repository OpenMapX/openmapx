"use client";

import { useNavigationStore } from "@openmapx/core";
import { useNavigationMutations } from "@/lib/mobile/useNavigationMutations";
import { useBackDismiss } from "@/lib/useBackDismiss";

/**
 * Back during turn-by-turn or transit guidance ends the trip, like the End
 * button, and returns to the route that was being followed — instead of
 * leaving the app mid-trip.
 */
export function NavigationBackHandler() {
  const navigating = useNavigationStore((s) => s.status !== "idle");
  const { endNavigation } = useNavigationMutations();
  useBackDismiss(navigating, () => void endNavigation());
  return null;
}
