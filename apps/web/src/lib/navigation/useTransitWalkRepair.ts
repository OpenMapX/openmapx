"use client";
import {
  apiClient,
  fetchDirections,
  haversineDistance,
  useNavigationStore,
  useSettingsStore,
} from "@openmapx/core";
import { transitItineraryFingerprint } from "@openmapx/core/navigation";
import { useLocale } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { useMobileRuntimeContext } from "../mobile/MobileRuntimeProvider";
/** Recompute only a deviated walking leg; the selected services are immutable here. */
export function useTransitWalkRepair() {
  const runtime = useMobileRuntimeContext();
  const locale = useLocale();
  const p = useNavigationStore((s) => s.transitProgress);
  const itinerary = useNavigationStore((s) => s.itinerary);
  const status = useNavigationStore((s) => s.status);
  const session = useNavigationStore((s) => s.nativeSessionId ?? s.transitRequestId);
  const firstDeviation = useRef<{ key: string; at: number } | null>(null);
  const flight = useRef<{ key: string; controller: AbortController } | null>(null);
  const nextAttempt = useRef(0);
  const [state, setState] = useState<"idle" | "repairing" | "unavailable" | "accessibility">(
    "idle",
  );
  const key = `${session}:${itinerary ? transitItineraryFingerprint(itinerary) : ""}:${p?.currentLegIndex ?? 0}`;
  // biome-ignore lint/correctness/useExhaustiveDependencies: journey/leg identity owns cancellation and retry state.
  useEffect(() => {
    setState("idle");
    return () => {
      flight.current?.controller.abort();
      flight.current = null;
      firstDeviation.current = null;
      nextAttempt.current = 0;
    };
  }, [key]);
  useEffect(() => {
    if (
      !itinerary ||
      status !== "navigating" ||
      p?.phase !== "walking" ||
      !p.position ||
      !p.positionTimestampMs ||
      Date.now() - p.positionTimestampMs > 30000
    )
      return;
    const legIndex = p.currentLegIndex;
    const leg = itinerary.legs[legIndex];
    if (leg?.mode !== "walking") return;
    if (p.deviationMeters <= 45) {
      firstDeviation.current = null;
      if (!flight.current) setState("idle");
      return;
    }
    if (!firstDeviation.current || firstDeviation.current.key !== key) {
      firstDeviation.current = { key, at: p.positionTimestampMs };
      return;
    }
    if (
      p.positionTimestampMs - firstDeviation.current.at < 3000 ||
      Date.now() < nextAttempt.current ||
      flight.current
    )
      return;
    if (useNavigationStore.getState().transitReplanOptions?.wheelchairRequired) {
      setState("accessibility");
      return;
    }
    if (!runtime.browserAuthority && !runtime.handshake?.capabilities.transitActions) return;
    const controller = new AbortController();
    const run = { key, controller };
    flight.current = run;
    setState("repairing");
    nextAttempt.current = Date.now() + 30000;
    const origin = p.position;
    void fetchDirections(
      {
        waypoints: [origin, [leg.to.lng, leg.to.lat]],
        mode: "walking",
        lang: locale,
        units: useSettingsStore.getState().units,
      },
      apiClient,
      { signal: controller.signal, timeoutMs: 15000 },
    )
      .then(async (response) => {
        const s = useNavigationStore.getState();
        const currentKey = `${s.nativeSessionId ?? s.transitRequestId}:${s.itinerary ? transitItineraryFingerprint(s.itinerary) : ""}:${s.transitProgress?.currentLegIndex ?? 0}`;
        if (
          controller.signal.aborted ||
          currentKey !== key ||
          s.status !== "navigating" ||
          s.transitProgress?.phase !== "walking"
        )
          return;
        const position = s.transitProgress.position;
        const timestamp = s.transitProgress.positionTimestampMs;
        if (
          !position ||
          !timestamp ||
          Date.now() - timestamp > 30000 ||
          haversineDistance(origin, position) > 100
        )
          throw Error("position-changed");
        const route = response.routes?.[response.activeRouteIndex ?? 0];
        if (!route) throw Error("no-walking-route");
        if (runtime.browserAuthority) {
          if (!s.repairTransitWalk(legIndex, route)) throw Error("invalid-route");
        } else {
          if (!runtime.commands) throw Error("unavailable");
          await runtime.commands.repairTransitWalk(
            s.nativeRouteFingerprint ?? transitItineraryFingerprint(itinerary),
            legIndex,
            route,
          );
        }
        setState("idle");
        firstDeviation.current = null;
      })
      .catch(() => {
        if (!controller.signal.aborted) setState("unavailable");
      })
      .finally(() => {
        if (flight.current === run) flight.current = null;
      });
  }, [p, itinerary, status, key, locale, runtime]);
  return state;
}
