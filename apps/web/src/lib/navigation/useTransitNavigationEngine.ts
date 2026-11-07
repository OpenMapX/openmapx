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
import { useQueries, useQueryClient } from "@tanstack/react-query";
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
  const connectivity = useNavigationStore((s) => s.connectivity);
  const awaitingRecovery = useNavigationStore((s) => s.liveDataUnavailable);
  const queryClient = useQueryClient();
  const recoveryBaseline = useRef<{
    owner: string;
    queries: { data: number; settled: number; pending: boolean }[];
  } | null>(null);
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
      refetchOnReconnect: "always" as const,
      refetchInterval: 30000,
      retry: 1,
    })),
  });
  const queryStates = trips.map(
    (id) =>
      queryClient
        .getQueryCache()
        .find({ queryKey: ["vehicle-journey", id, undefined], exact: true })?.state,
  );
  // Reading isFetching below subscribes these observers to fetch completion,
  // including structurally shared responses with identical timestamps.
  const updateCounts = queryStates.map((state) => state?.dataUpdateCount ?? 0);
  const settledCounts = queryStates.map(
    (state) => (state?.dataUpdateCount ?? 0) + (state?.errorUpdateCount ?? 0),
  );
  const captured = useNavigationStore((s) => s.transitCaptures);
  const ready = journeys.every((j) => j.isSuccess || j.isError);
  useEffect(() => {
    if (!itinerary || !active || !ready || trips.length === 0) return;
    const version = `${requestId}:${trips.join(",")}:${updateCounts.join(":")}`;
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
  }, [itinerary, active, ready, captured, trips, journeys, requestId, updateCounts]);
  useEffect(() => {
    const store = useNavigationStore.getState();
    if (
      !active ||
      store.navigationAuthority !== "browser" ||
      store.status !== "navigating" ||
      store.kind !== "transit" ||
      store.transitRequestId !== requestId ||
      store.itinerary !== itinerary ||
      !itinerary
    )
      return;
    if (connectivity === "online" && awaitingRecovery && trips.length === 0) {
      store.setLiveDataUnavailable(false);
      return;
    }
    const owner = JSON.stringify([requestId, trips]);
    const counts = updateCounts;
    const baseline = recoveryBaseline.current;
    // Cached data on mount, a new session, and offline completions establish
    // a baseline; only subsequent successful observations prove recovery.
    // A request already in flight belongs to that baseline too.
    if (!baseline || baseline.owner !== owner || connectivity === "offline" || !awaitingRecovery) {
      recoveryBaseline.current = {
        owner,
        queries: counts.map((data, i) => ({
          data,
          settled: settledCounts[i],
          pending: journeys[i].isFetching,
        })),
      };
      return;
    }
    // Cancellation can settle without increasing either query counter.
    baseline.queries.forEach((query, i) => {
      if (!journeys[i].isFetching && settledCounts[i] === query.settled) query.pending = false;
    });
    if (
      !journeys.every(
        (q, i) =>
          q.isSuccess &&
          !q.isFetching &&
          q.data?.data &&
          q.data.freshness?.hasRealtimeData &&
          !q.data.freshness?.isStale &&
          !q.data.freshness?.isPartial &&
          counts[i] > baseline.queries[i].data &&
          (!baseline.queries[i].pending || settledCounts[i] > baseline.queries[i].settled + 1),
      )
    )
      return;
    const byTrip = Object.fromEntries(trips.map((id, i) => [id, journeys[i].data?.data?.stops]));
    const fresh = captureTransitLegStops(itinerary.legs, byTrip, Date.now()).filter((c) =>
      trips.includes(c.tripId),
    );
    if (
      !fresh.length ||
      fresh.some((c) => {
        const held = store.transitCaptures.find(
          (old) => old.legIndex === c.legIndex && old.tripId === c.tripId,
        );
        return (
          c.status !== "captured" ||
          held?.status !== "captured" ||
          JSON.stringify(c.stops.map((s) => s.stopId)) !==
            JSON.stringify(held.stops.map((s) => s.stopId))
        );
      })
    )
      return;
    store.setLiveDataUnavailable(false);
  }, [
    active,
    itinerary,
    requestId,
    trips,
    journeys,
    connectivity,
    awaitingRecovery,
    updateCounts,
    settledCounts,
  ]);
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
