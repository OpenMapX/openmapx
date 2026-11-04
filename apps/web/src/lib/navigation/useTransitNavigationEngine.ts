"use client";
import {
  type FixInput,
  fetchVehicleJourney,
  prepareTransitProgress,
  useNavigationStore,
  useTransitStopAreas,
} from "@openmapx/core";
import {
  captureTransitLegStops,
  DEFAULT_TRANSIT_TICK_OPTIONS,
  freshTransitTickState,
  processTransitFix,
  refreshTransitCaptures,
  transitItineraryFingerprint,
  transitProgressFromTick,
} from "@openmapx/core/navigation";
import { useQueries } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { haptics } from "../haptics";
import { useWatchPosition } from "../useWatchPosition";
/** Browser owner of fixes; connection changes are exclusively rider decisions. */
export function useTransitNavigationEngine(): void {
  const itinerary = useNavigationStore((s) => s.itinerary);
  const requestId = useNavigationStore((s) => s.transitRequestId);
  const currentLegIndex = useNavigationStore((s) => s.transitProgress?.currentLegIndex ?? 0);
  const captureVersion = useRef("");
  const active = useNavigationStore((s) => s.kind === "transit" && s.status === "navigating");
  const prepared = useMemo(
    () => (itinerary ? prepareTransitProgress(itinerary) : null),
    [itinerary],
  );
  const stopAreas = useTransitStopAreas(itinerary);
  useEffect(() => {
    const store = useNavigationStore.getState();
    if (
      store.navigationAuthority === "browser" &&
      store.itinerary === itinerary &&
      store.transitRequestId === requestId
    )
      useNavigationStore.setState({ transitStopAreas: stopAreas });
  }, [itinerary, requestId, stopAreas]);
  const trips = useMemo(
    () =>
      [
        ...new Set(
          (itinerary?.legs?.slice(currentLegIndex) ?? []).flatMap((l) =>
            l.tripId ? [l.tripId] : [],
          ),
        ),
      ].slice(0, 4),
    [itinerary, currentLegIndex],
  );
  const journeys = useQueries({
    queries: trips.map((tripId) => ({
      queryKey: ["vehicle-journey", tripId, undefined],
      queryFn: () => fetchVehicleJourney({ tripId }, undefined, { timeoutMs: 8000 }),
      enabled: active,
      staleTime: 30000,
      retry: 1,
    })),
  });
  const captured = useNavigationStore((s) => s.transitCaptures);
  const ready = journeys.every((j) => j.isSuccess || j.isError);
  useEffect(() => {
    if (!itinerary || !active || !ready || trips.length === 0) return;
    const version = `${requestId}:${trips.join(",")}:${journeys.map((j) => j.dataUpdatedAt).join(":")}`;
    if (captureVersion.current === version) return;
    captureVersion.current = version;
    const byTrip = Object.fromEntries(trips.map((id, i) => [id, journeys[i].data?.data?.stops]));
    useNavigationStore
      .getState()
      .setTransitCaptures(
        captured.length === 0
          ? captureTransitLegStops(itinerary.legs, byTrip, Date.now())
          : refreshTransitCaptures(captured, itinerary.legs, byTrip, Date.now()),
      );
  }, [itinerary, active, ready, captured, trips, journeys, requestId]);
  const tick = useCallback(
    (fix?: FixInput) => {
      const store = useNavigationStore.getState();
      if (
        store.kind !== "transit" ||
        store.status !== "navigating" ||
        store.itinerary !== itinerary ||
        !itinerary ||
        !prepared
      )
        return;
      const nowMs = Date.now();
      const result = processTransitFix({
        itinerary,
        captures: store.transitCaptures,
        state: store.transitTickState ?? freshTransitTickState(nowMs, itinerary),
        fix,
        nowMs,
        options: {
          ...DEFAULT_TRANSIT_TICK_OPTIONS,
          itineraryFingerprint: transitItineraryFingerprint(itinerary),
        },
        prepared,
        stopAreas,
      });
      const tp = transitProgressFromTick(result.state, prepared);
      useNavigationStore.setState({ transitTickState: result.state, transitProgress: tp });
      if (tp.arrived) {
        haptics.success();
        store.completeArrival();
      }
    },
    [itinerary, prepared, stopAreas],
  );
  useWatchPosition(active, tick);
  useEffect(() => {
    if (!active) return;
    tick();
    const timer = setInterval(() => tick(), 5000);
    return () => clearInterval(timer);
  }, [active, tick]);
}
