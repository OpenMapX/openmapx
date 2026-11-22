"use client";

import type { RoadConditionRouteImpact, Route, Waypoint } from "@openmapx/core";
import { useDirectionsStore, useSettingsStore } from "@openmapx/core";
import { useLocale } from "next-intl";
import { useSyncExternalStore } from "react";
import { useMobileRuntimeContext } from "@/lib/mobile/MobileRuntimeProvider";
import { type StartFailure, useStartNavigation } from "@/lib/mobile/useStartNavigation";
import { primeSpeechSynthesis } from "@/lib/navigation/useNavigationVoice";
import { requestHeadingPermission } from "@/lib/useHeading";

const GROUND_MODES = new Set<Route["mode"]>(["driving", "walking", "cycling", "motorcycle"]);

/** Modes that support turn-by-turn ground navigation from the route planner. */
export function canStartGroundNavigation(mode: Route["mode"]): boolean {
  return GROUND_MODES.has(mode);
}

interface StartFlightSnapshot {
  starting: boolean;
  error: StartFailure | null;
  errorRoute: Route | null;
}

class StartFlightStore {
  private snapshot: StartFlightSnapshot = { starting: false, error: null, errorRoute: null };
  private readonly listeners = new Set<() => void>();

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getSnapshot = () => this.snapshot;

  set(next: StartFlightSnapshot) {
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }
}

// Scoped to the active runtime's command owner so summary cards and the
// details view share one in-flight lock (preventing a second queued native
// session if the user opens Details mid-prepare), while separate runtimes and
// tests never share state.
const BROWSER_START_KEY = {};
const startFlights = new WeakMap<object, StartFlightStore>();

function startFlightFor(key: object): StartFlightStore {
  let store = startFlights.get(key);
  if (!store) {
    store = new StartFlightStore();
    startFlights.set(key, store);
  }
  return store;
}

export interface UseGroundRouteStartParams {
  route: Route;
  waypoints: readonly Waypoint[];
  index?: number;
  alternatives?: readonly Route[];
  provider?: string;
  roadConditionImpact?: RoadConditionRouteImpact;
  units: "metric" | "imperial";
}

/**
 * Shared ground-navigation start flow for route cards, multi-stop summaries,
 * and route details views (browser and installed-app authority).
 */
export function useGroundRouteStart({
  route,
  waypoints,
  index = 0,
  alternatives = [],
  provider,
  roadConditionImpact,
  units,
}: UseGroundRouteStartParams) {
  const locale = useLocale();
  const runtime = useMobileRuntimeContext();
  const { startGround } = useStartNavigation();
  const flight = startFlightFor(runtime.commands ?? BROWSER_START_KEY);
  const { starting, error, errorRoute } = useSyncExternalStore(
    flight.subscribe,
    flight.getSnapshot,
    flight.getSnapshot,
  );

  const canStart = canStartGroundNavigation(route.mode);
  const startError = errorRoute === route ? error : null;

  const start = async () => {
    const coords = waypoints.map((w) => w.coords).filter((c): c is [number, number] => c !== null);
    if (coords.length < 2) return;
    // Unlock TTS inside the user gesture (iOS Safari requirement) before any
    // await hands control back to the event loop.
    primeSpeechSynthesis();
    if (flight.getSnapshot().starting) return;
    flight.set({ starting: true, error: null, errorRoute: null });
    let nextError: StartFailure | null = null;
    try {
      const {
        avoidHighways,
        avoidTolls,
        avoidFerries,
        bikeProfile,
        bikeHillPreference,
        bikePreferQuietRoads,
        bikePreferSmoothSurfaces,
        bikeSpeedKmh,
      } = useDirectionsStore.getState();
      const avoidIncidents = useSettingsStore.getState().avoidIncidents;
      const result = await startGround(
        {
          route,
          alternatives,
          mode: route.mode,
          destinationWaypoints: coords,
          routeProvider: provider,
          routeSelectionIntent: index === 0 ? "automatic" : "userSelected",
          routeOptions: {
            avoidHighways: route.mode === "driving" && avoidHighways,
            avoidTolls: route.mode === "driving" && avoidTolls,
            avoidFerries,
            ...(route.mode === "cycling"
              ? {
                  bikeProfile,
                  bikeHillPreference,
                  bikePreferQuietRoads,
                  bikePreferSmoothSurfaces,
                  bikeSpeedKmh,
                }
              : {}),
            avoidClosures: avoidIncidents,
          },
          roadConditionImpact,
          locale: locale === "de" ? "de" : "en",
          units,
        },
        // Between prepare and start, so the OS prompt is spent on a trip the
        // shell has already accepted.
        {
          onPrepared: async () => {
            await requestHeadingPermission();
          },
        },
      );
      nextError = result.ok ? null : result.code;
    } finally {
      flight.set({
        starting: false,
        error: nextError,
        errorRoute: nextError ? route : null,
      });
    }
  };

  return { canStart, start, starting, startError } as const;
}
