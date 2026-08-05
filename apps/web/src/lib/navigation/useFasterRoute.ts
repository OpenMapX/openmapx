"use client";

import {
  evaluateFasterRoute,
  FASTER_ROUTE_DEFAULTS,
  fetchDirections,
  prepareRouteMatcher,
  remainingWaypoints,
  useNavigationStore,
  useSettingsStore,
} from "@openmapx/core";
import { useLocale } from "next-intl";
import { useEffect } from "react";
import { useNavRecordingStore } from "./navRecordingStore";

/** How often to ask whether a better route exists. */
const CHECK_INTERVAL_MS = 300_000;

/**
 * Periodically re-plans from the driver's current position and offers a
 * materially faster route when traffic has made one available.
 */
export function useFasterRoute(): void {
  const locale = useLocale();
  const route = useNavigationStore((s) => s.route);
  const connectivity = useNavigationStore((s) => s.connectivity);
  const enabled = useSettingsStore((s) => s.fasterRoutes);

  useEffect(() => {
    if (!enabled && useNavigationStore.getState().fasterRoute) {
      // Turning offers off also withdraws an offer already on screen, but it
      // does not mark the trip as dismissed: re-enabling the setting should
      // resume normal polling.
      useNavigationStore.getState().clearFasterRoute();
    }
  }, [enabled]);

  // A position change invalidates an offer computed from the old route.
  const offRoute = useNavigationStore((s) => s.offRoute);
  useEffect(() => {
    if ((offRoute || connectivity === "offline") && useNavigationStore.getState().fasterRoute) {
      useNavigationStore.getState().clearFasterRoute();
    }
  }, [offRoute, connectivity]);

  useEffect(() => {
    if (!enabled || !route || route.geometry.length < 2) return;

    // One index for the route this polling cycle belongs to. The effect is keyed
    // on the route, so a reroute tears the cycle down and the next one indexes
    // the new geometry — nothing is built inside `check`.
    const matcher = prepareRouteMatcher(route.geometry);

    let cancelled = false;

    const check = () => {
      const s = useNavigationStore.getState();
      if (s.status !== "navigating" || s.kind !== "ground" || s.mode !== "driving") return;
      if (
        s.offRoute ||
        s.coasting ||
        s.weakGps ||
        s.fasterRoute ||
        s.connectivity === "offline" ||
        s.rerouteUnavailable
      )
        return;
      if (s.fasterRouteSuppressed) return;
      if (!s.route || !s.progress) return;
      if (useNavRecordingStore.getState().replaying) return;
      if (typeof navigator !== "undefined" && navigator.onLine === false) return;

      const active = s.route;
      const { progress } = s;
      const remainingSeconds = (progress.etaEpochMs - Date.now()) / 1000;
      if (remainingSeconds <= 0) return;

      try {
        const waypoints = remainingWaypoints(
          // A route swap that has not yet retriggered the effect falls back to
          // its own geometry rather than reusing an index built for the old one.
          active === route ? matcher : active.geometry,
          s.destinationWaypoints,
          progress.snapped,
          progress.alongMeters,
        );

        void fetchDirections({
          waypoints,
          mode: "driving",
          lang: locale,
          ...s.routeOptions,
        })
          .then((res) => {
            if (cancelled) return;
            const now = useNavigationStore.getState();
            // The answer belongs to the route and setting state used to request it.
            if (
              now.route !== active ||
              now.status !== "navigating" ||
              now.mode !== "driving" ||
              !useSettingsStore.getState().fasterRoutes
            ) {
              return;
            }
            if (now.offRoute || now.coasting || now.weakGps || now.fasterRoute) return;
            const candidates = res.routes ?? [];
            const { faster } = evaluateFasterRoute(
              active,
              progress.alongMeters,
              remainingSeconds,
              candidates,
              { ...FASTER_ROUTE_DEFAULTS, speedMps: progress.speedMps },
            );
            if (!faster) return;
            useNavigationStore.getState().proposeFasterRoute({
              route: faster.route,
              alternatives: candidates.filter((r) => r !== faster.route),
              savedSeconds: faster.savedSeconds,
              proposedAtMs: Date.now(),
            });
          })
          .catch(() => {
            // Offline, timeout, HTTP error, or malformed data: skip this cycle.
          });
      } catch {
        // Building the request must not be able to break navigation either.
      }
    };

    const timer = setInterval(check, CHECK_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [route, enabled, locale]);
}
