import type { TravelMode } from "@openmapx/core";
import { useDirectionsStore, useSettingsStore } from "@openmapx/core";
import { useShallow } from "zustand/react/shallow";
import { type RoutingEngine, useRoutingEngines } from "@/lib/useRoutingEngines";
import {
  GROUND_FALLBACK_MODES,
  type GroundFallbackMode,
  type RouteRecoveryActions,
} from "./RouteResultStates";

interface RouteRecoveryInput {
  focusWaypoint: (index: number) => void;
  switchMode: (mode: TravelMode) => void;
  /**
   * The routing integration whose answer failed or came back empty, when the
   * answer names one; another engine is offered only beside a known one.
   */
  failedEngine?: string;
}

export type RecoveryEngine = Pick<
  RoutingEngine,
  "id" | "name" | "available" | "modes" | "timeAware" | "exclusions"
>;

export interface RouteRecoveryRequest {
  mode: TravelMode;
  /** The trip pins a departure, an arrival or a stop window. */
  scheduled: boolean;
  avoidIncidents: boolean;
  failed: string | undefined;
  engines: readonly RecoveryEngine[];
}

export interface OtherEngineOption {
  kind: "other-engine";
  integrationId: string;
  name: string;
}

function serves(engine: RecoveryEngine, mode: TravelMode, request: RouteRecoveryRequest) {
  return (
    engine.available &&
    engine.modes.includes(mode) &&
    (!request.scheduled || engine.timeAware) &&
    (!request.avoidIncidents || engine.exclusions)
  );
}

/**
 * What a failed or empty answer can offer, decided from the engines'
 * capabilities: each other ground mode some available engine plans with the
 * trip's settings, and each other available engine that can serve the same
 * request.
 */
export function routeRecoveryOptions(request: RouteRecoveryRequest): {
  modes: GroundFallbackMode[];
  engines: OtherEngineOption[];
} {
  const { mode, failed, engines } = request;
  return {
    modes: GROUND_FALLBACK_MODES.filter(
      (candidate) =>
        candidate !== mode && engines.some((engine) => serves(engine, candidate, request)),
    ),
    engines:
      failed === undefined
        ? []
        : engines
            .filter((engine) => engine.id !== failed && serves(engine, mode, request))
            .map((engine) => ({
              kind: "other-engine" as const,
              integrationId: engine.id,
              name: engine.name,
            })),
  };
}

/**
 * What a failed or empty route answer offers: editing the ends, another
 * ground mode, or the same trip on another routing engine.
 */
export function useRouteRecovery({
  focusWaypoint,
  switchMode,
  failedEngine,
}: RouteRecoveryInput): RouteRecoveryActions {
  const engines = useRoutingEngines();
  const avoidIncidents = useSettingsStore((s) => s.avoidIncidents);
  const { mode, waypoints, timeMode, tripTime, isEvMode, setRoutingProvider } = useDirectionsStore(
    useShallow((s) => ({
      mode: s.mode,
      waypoints: s.waypoints,
      timeMode: s.timeMode,
      tripTime: s.tripTime,
      isEvMode: s.isEvMode,
      setRoutingProvider: s.setRoutingProvider,
    })),
  );
  const stopWindows = waypoints.some((wp) => wp.schedule !== undefined);
  const options = routeRecoveryOptions({
    mode,
    scheduled: stopWindows || (timeMode !== "now" && tripTime !== null),
    avoidIncidents,
    // EV and stop-window trips are planned by their own endpoints, which take no pin.
    failed: isEvMode || stopWindows ? undefined : failedEngine,
    engines,
  });
  return {
    onEditOrigin: () => focusWaypoint(0),
    onEditDestination: () => focusWaypoint(waypoints.length - 1),
    modes: options.modes,
    onSelectMode: switchMode,
    engines: options.engines,
    onSelectEngine: setRoutingProvider,
  };
}
