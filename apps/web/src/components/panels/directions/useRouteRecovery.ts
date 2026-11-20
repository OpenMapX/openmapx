import type { TravelMode } from "@openmapx/core";
import { useCapabilities, useDirectionsStore, useSettingsStore } from "@openmapx/core";
import { useShallow } from "zustand/react/shallow";
import { GROUND_FALLBACK_MODES, type RouteRecoveryActions } from "./RouteResultStates";

interface RouteRecoveryInput {
  focusWaypoint: (index: number) => void;
  switchMode: (mode: TravelMode) => void;
}

/**
 * What a failed or empty route answer offers: editing the ends, or another
 * ground mode an available router can plan with the current trip settings.
 */
export function useRouteRecovery({
  focusWaypoint,
  switchMode,
}: RouteRecoveryInput): RouteRecoveryActions {
  const { services: caps } = useCapabilities();
  const avoidIncidents = useSettingsStore((s) => s.avoidIncidents);
  const { mode, waypoints, timeMode, tripTime } = useDirectionsStore(
    useShallow((s) => ({
      mode: s.mode,
      waypoints: s.waypoints,
      timeMode: s.timeMode,
      tripTime: s.tripTime,
    })),
  );
  const valhallaAvailable = caps["routing-valhalla"]?.available === true;
  const osrmAvailable =
    caps["routing-osrm"]?.available === true &&
    !avoidIncidents &&
    !waypoints.some((wp) => wp.schedule !== undefined) &&
    !(timeMode !== "now" && tripTime);
  return {
    onEditOrigin: () => focusWaypoint(0),
    onEditDestination: () => focusWaypoint(waypoints.length - 1),
    modes: GROUND_FALLBACK_MODES.filter(
      (candidate) =>
        candidate !== mode &&
        (candidate === "driving" ? valhallaAvailable || osrmAvailable : valhallaAvailable),
    ),
    onSelectMode: switchMode,
  };
}
