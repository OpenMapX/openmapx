"use client";

import {
  guidanceApproachMeters,
  junctionPhotoApproachMeters,
  upcomingManeuverIndex,
  useNavigationStore,
  useSettingsStore,
} from "@openmapx/core";
import { useMapAttributions } from "@/integration-api/overlay/useMapAttributions";
import { OSM_ATTRIBUTION } from "@/lib/map";
import { useNavJunctionStore } from "@/lib/navigation/junctionStore";
import { JunctionViewPanel } from "./junction/JunctionViewPanel";

const OSM_CREDIT = [OSM_ATTRIBUTION];
const NO_CREDIT: typeof OSM_CREDIT = [];

/**
 * The junction card slot under the maneuver banner. O(1) work per fix: look
 * up the decision point for the upcoming step, compare the distance to the
 * approach window, and read the gantry and photo from the store. Mounts the
 * panel only when there is something to draw. While a gantry built from OSM
 * way tags is on screen, the map attribution carries the OSM credit
 * explicitly rather than relying on the basemap's string.
 */
export function JunctionViewSlot() {
  const status = useNavigationStore((s) => s.status);
  const mode = useNavigationStore((s) => s.mode);
  const stepCount = useNavigationStore((s) => s.route?.steps.length ?? 0);
  const geometry = useNavigationStore((s) => s.route?.geometry);
  const currentStepIndex = useNavigationStore((s) => s.progress?.currentStepIndex);
  const distanceToNextManeuver = useNavigationStore((s) => s.progress?.distanceToNextManeuver);
  const speedMps = useNavigationStore((s) => s.progress?.speedMps);
  const junctionView = useSettingsStore((s) => s.junctionView);
  const junctionPhotos = useSettingsStore((s) => s.junctionPhotos);

  const routeKey = useNavJunctionStore((s) => s.routeKey);
  const byStep = useNavJunctionStore((s) => s.byStep);
  const gantryByStep = useNavJunctionStore((s) => s.gantryByStep);
  const photoByStep = useNavJunctionStore((s) => s.photoByStep);

  const upcomingIndex = upcomingManeuverIndex(currentStepIndex ?? 0, stepCount);
  const point = routeKey !== null ? byStep.get(upcomingIndex) : undefined;
  const gantry = point && gantryByStep.get(upcomingIndex);
  const photo = point && photoByStep.get(upcomingIndex);

  const visible =
    junctionView &&
    !!point &&
    (status === "navigating" || status === "rerouting") &&
    (mode === "driving" || mode === "motorcycle") &&
    distanceToNextManeuver !== undefined &&
    distanceToNextManeuver <= guidanceApproachMeters(mode, speedMps ?? 0) &&
    // Something to draw: a sign, engine lanes, or a fetched gantry. A bare
    // `keep` with none of those stays hidden.
    (!!point.sign || (point.laneCount ?? 0) > 0 || !!gantry);

  // The gantry goes up with the rest of the guidance; the photo waits until
  // what it shows is nearly in front of the windscreen. Photos switched off
  // mid-drive leave at once, including ones already fetched.
  const photoVisible =
    junctionPhotos &&
    distanceToNextManeuver !== undefined &&
    distanceToNextManeuver <= junctionPhotoApproachMeters(mode, speedMps ?? 0);

  useMapAttributions("nav-junction", visible && gantry?.source === "osm" ? OSM_CREDIT : NO_CREDIT);

  if (!visible) return null;
  return (
    <JunctionViewPanel
      point={point}
      gantry={gantry}
      photo={photoVisible ? photo : undefined}
      geometry={geometry}
    />
  );
}
