"use client";

import { useNavigationStore } from "@openmapx/core";
import { useRef } from "react";

/** How far the traveller must move north or south before the route widths are rebuilt. */
const REBUILD_DEGREES = 1;

/**
 * The latitude the navigation route's real-width expression is built for: the
 * puck's, or the route start before the first fix. It only changes after a move
 * of more than a degree, so the width expression (and with it the layer
 * paint) stays put for the whole of an ordinary trip.
 */
export function useNavRouteWidthLatitude(): number {
  const live = useNavigationStore(
    (s) => s.progress?.snapped?.[1] ?? s.route?.geometry[0]?.[1] ?? 0,
  );
  const held = useRef<number | null>(null);
  if (held.current === null || Math.abs(live - held.current) > REBUILD_DEGREES) {
    held.current = live;
  }
  return held.current;
}
