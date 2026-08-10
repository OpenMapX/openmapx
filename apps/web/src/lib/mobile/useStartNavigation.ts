"use client";

import {
  buildGroundNavigationPackage,
  type GroundNavigationSettings,
  type LngLat,
  type NavigationRouteOptions,
  type Route,
  type TransitReplanOptions,
  type TravelMode,
  useNavigationStore,
} from "@openmapx/core";
import type { ApiClient } from "@openmapx/core/navigation/api";
import type { TripItinerary } from "@openmapx/mobility-core/transit";
import { useCallback } from "react";
import { useMobileRuntimeContext } from "./MobileRuntimeProvider";
import { degradedLegIndices, prepareTransitStart } from "./transitCapture";

/**
 * Starting a trip under whichever authority is actually in charge.
 *
 * In a browser this is the store action it has always been. In the shell it is
 * native-first: build a bounded package, ask the shell to prepare it, run the
 * permission flow, start, and only then let the navigation UI appear. The
 * tempting alternative — start the browser store optimistically and roll back if
 * native refuses — puts "you are navigating" in front of the driver before it is
 * true, and rolling that back is worse than never having said it.
 */

export type StartFailure =
  | "aborted"
  | "invalid-route"
  | "route-too-large"
  | "permission-denied"
  | "unavailable"
  | "incompatible"
  | "timeout"
  | "rejected";

export interface StartGroundInput {
  route: Route;
  alternatives?: readonly Route[];
  mode: TravelMode;
  destinationWaypoints: readonly LngLat[];
  routeProvider?: string;
  routeSelectionIntent: "automatic" | "userSelected";
  routeOptions: NavigationRouteOptions;
  locale: "en" | "de";
  units: "metric" | "imperial";
}

export interface StartTransitInput {
  itinerary: TripItinerary;
  /** Used to capture each ridden leg's stops before the session starts. */
  client: ApiClient;
  replanOptions?: TransitReplanOptions;
  locale: "en" | "de";
  units: "metric" | "imperial";
  signal?: AbortSignal;
  /** Reports which legs will run on schedule data alone. */
  onCaptured?: (degradedLegIndices: readonly number[]) => void;
}

export type StartResult = { ok: true } | { ok: false; code: StartFailure };

export interface StartNavigationOptions {
  /** Runs between prepare and start, where the OS permission prompt belongs. */
  onPrepared?: () => Promise<void> | void;
}

export function useStartNavigation() {
  const runtime = useMobileRuntimeContext();

  const startGround = useCallback(
    async (input: StartGroundInput, options: StartNavigationOptions = {}): Promise<StartResult> => {
      const store = useNavigationStore.getState();

      if (runtime.browserAuthority) {
        store.startGroundNavigation(
          input.route,
          input.mode,
          [...input.destinationWaypoints],
          [...(input.alternatives ?? [])],
          input.routeProvider,
          { routeIntent: input.routeSelectionIntent, routeOptions: input.routeOptions },
        );
        return { ok: true };
      }

      if (!runtime.commands || runtime.state !== "native-compatible") {
        // Negotiating, incompatible, or errored. None of them is permission to
        // start a second engine here.
        return {
          ok: false,
          code: runtime.state === "native-incompatible" ? "incompatible" : "unavailable",
        };
      }

      const settings: GroundNavigationSettings = {
        voiceEnabled: store.voiceEnabled,
        keepScreenOn: store.keepScreenOn,
        voiceTiming: "normal",
      };

      const built = buildGroundNavigationPackage({
        route: input.route,
        alternatives: input.alternatives,
        mode: input.mode,
        destinationWaypoints: input.destinationWaypoints,
        routeProvider: input.routeProvider,
        routeSelectionIntent: input.routeSelectionIntent,
        routeOptions: input.routeOptions as unknown as Record<string, unknown>,
        locale: input.locale,
        units: input.units,
        settings,
      });
      if (!built.ok) {
        return {
          ok: false,
          code: built.code === "route-too-large" ? "route-too-large" : "invalid-route",
        };
      }

      try {
        // Nothing is written to the store here: the authoritative snapshot that
        // follows `session.started` is what makes the session visible, so there
        // is no half-started state to undo if any of this fails.
        await runtime.commands.start(built.startPackage, options.onPrepared);
        return { ok: true };
      } catch (error) {
        const code = (error as { code?: StartFailure }).code;
        return { ok: false, code: code ?? "rejected" };
      }
    },
    [runtime],
  );

  const startTransit = useCallback(
    async (
      input: StartTransitInput,
      options: StartNavigationOptions = {},
    ): Promise<StartResult> => {
      const store = useNavigationStore.getState();

      if (runtime.browserAuthority) {
        store.startTransitNavigation(input.itinerary, input.replanOptions);
        return { ok: true };
      }

      if (!runtime.commands || runtime.state !== "native-compatible") {
        return {
          ok: false,
          code: runtime.state === "native-incompatible" ? "incompatible" : "unavailable",
        };
      }

      // Captured while the connection still works. Underground, the stop count
      // this produces is the only thing the rider has.
      const prepared = await prepareTransitStart({
        itinerary: input.itinerary,
        client: input.client,
        locale: input.locale,
        units: input.units,
        settings: {
          voiceEnabled: store.voiceEnabled,
          keepScreenOn: store.keepScreenOn,
          alightAlertsEnabled: true,
        },
        replanOptions: input.replanOptions as unknown as Record<string, unknown> | undefined,
        capturedAtMs: Date.now(),
        signal: input.signal,
      });
      if (!prepared.ok) {
        return { ok: false, code: prepared.code === "aborted" ? "aborted" : "invalid-route" };
      }
      input.onCaptured?.(degradedLegIndices(input.itinerary, prepared.outcomes));

      try {
        await runtime.commands.start(prepared.startPackage, options.onPrepared);
        return { ok: true };
      } catch (error) {
        const code = (error as { code?: StartFailure }).code;
        return { ok: false, code: code ?? "rejected" };
      }
    },
    [runtime],
  );

  return { startGround, startTransit, browserAuthority: runtime.browserAuthority } as const;
}
