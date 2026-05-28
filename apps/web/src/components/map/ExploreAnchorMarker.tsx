"use client";

import { useCategorySearchStore } from "@openmapx/core";
import { usePinMarker } from "@/hooks/usePinMarker";

const PIN_BLUE = { fill: "#4285F4", stroke: "#1967D2" };

/**
 * Blue pin marking the place a nearby/Explore search was started from. Renders
 * above the (canvas) result markers since it's a DOM marker. No label — the
 * search bar already shows the anchor name.
 */
export function ExploreAnchorMarker() {
  const anchor = useCategorySearchStore((s) => s.anchor);
  usePinMarker(anchor?.coordinates ?? null, "", false, PIN_BLUE);
  return null;
}
