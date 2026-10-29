import type { NavProgress, Route, TravelMode } from "@openmapx/core";
import { guidanceApproachMeters, upcomingManeuverIndex } from "@openmapx/core";

export interface NavCameraApproach {
  route: Route;
  maneuverIndex: number;
  exitMeters: number;
}

/**
 * Keep a maneuver's approach stable through speed/GPS jitter. The exit boundary
 * is fixed on entry: recomputing it from a slower fix would immediately undo
 * the zoom. A meaningful retreat can release it before the maneuver is passed.
 */
export function navCameraApproach(
  previous: NavCameraApproach | null,
  route: Route | null,
  mode: TravelMode,
  progress: NavProgress | null,
): NavCameraApproach | null {
  if (
    (mode !== "driving" && mode !== "motorcycle") ||
    !route ||
    !progress ||
    progress.currentStepIndex >= route.steps.length - 1 ||
    !Number.isFinite(progress.distanceToNextManeuver)
  ) {
    return null;
  }

  const maneuverIndex = upcomingManeuverIndex(progress.currentStepIndex, route.steps.length);
  const distance = progress.distanceToNextManeuver;
  if (previous?.route === route && previous.maneuverIndex === maneuverIndex) {
    return distance <= previous.exitMeters ? previous : null;
  }

  const entryMeters = guidanceApproachMeters(mode, progress.speedMps);
  if (distance > entryMeters) return null;
  return { route, maneuverIndex, exitMeters: entryMeters + Math.max(100, entryMeters * 0.1) };
}
