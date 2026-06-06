import {
  API_ENDPOINTS,
  apiClient,
  computeTransitProgress,
  detectMissedConnection,
  type FixInput,
  useNavigationStore,
} from "@openmapx/core";
import type { MobilityEnvelope } from "@openmapx/mobility-core/result";
import type { TripPlan } from "@openmapx/mobility-core/transit";
import { useCallback, useRef } from "react";
import { useMapOptional } from "@/lib/MapContext";
import { haptics } from "../haptics";
import { useWatchPosition } from "../useWatchPosition";

/**
 * Transit follow-along engine. Wires GPS fixes → computeTransitProgress →
 * navigationStore and recenters the map on the snapped position. On a detected
 * missed connection it performs an on-trip replan: it re-queries MOTIS from the
 * current position to the original destination and swaps in the new itinerary.
 */
/** Cooldown after a replan before another missed-connection retry may fire. */
const REPLAN_RETRY_COOLDOWN_MS = 30_000;

export function useTransitNavigationEngine(): void {
  const map = useMapOptional()?.mapRef.current ?? null;
  // Guards against firing overlapping replans while one is in flight.
  const replanningRef = useRef(false);
  // Earliest time a replan may retry after a failure, so a persistently failing
  // replan (destination temporarily unreachable, offline) doesn't fire on every
  // ~1Hz fix and storm the BFF.
  const nextReplanAllowedAtRef = useRef(0);

  const replan = useCallback(async (from: [number, number], to: [number, number]) => {
    if (replanningRef.current) return;
    replanningRef.current = true;
    useNavigationStore.getState().setTransitRerouteNeeded(true);
    try {
      // Reuse the user's original transit options, snapshotted into the
      // navigation store when the trip started (preferred modes, the
      // Deutschlandticket-filtered set, wheelchair, first/last-mile access).
      // Reading the snapshot — not the live directions store, which close()
      // resets to defaults — keeps the replan from silently routing onto
      // excluded/inaccessible legs, and respects the Germany-only D-Ticket gate
      // exactly as it was applied at planning time.
      const opts = useNavigationStore.getState().transitReplanOptions;
      const params: Record<string, string> = {
        from_lat: String(from[1]),
        from_lng: String(from[0]),
        to_lat: String(to[1]),
        to_lng: String(to[0]),
        time: new Date().toISOString(),
      };
      if (opts?.modes?.length) params.modes = opts.modes.join(",");
      if (opts?.wheelchair) params.wheelchair = "true";
      if (opts?.preTransitModes?.length) params.pre_modes = opts.preTransitModes.join(",");
      if (opts?.postTransitModes?.length) params.post_modes = opts.postTransitModes.join(",");
      if (opts?.directModes?.length) params.direct_modes = opts.directModes.join(",");

      const env = await apiClient.get<MobilityEnvelope<TripPlan>>(
        API_ENDPOINTS.transitPlan,
        params,
      );
      const next = env.data?.itineraries?.[0];
      const latest = useNavigationStore.getState();
      // Only apply if we're still in transit navigation (the user may have stopped).
      if (next && latest.status === "navigating" && latest.kind === "transit") {
        haptics.warn();
        // Back off after a successful replan too: the fresh itinerary's first
        // transit leg may still read as "missed" when no better option exists,
        // and replaceItinerary clears transitRerouteNeeded — without a cooldown
        // the next fix would re-fire the replan every ~1Hz and storm the BFF.
        nextReplanAllowedAtRef.current = Date.now() + REPLAN_RETRY_COOLDOWN_MS;
        latest.replaceItinerary(next);
      } else {
        // No alternative: back off before the next missed-connection retry.
        nextReplanAllowedAtRef.current = Date.now() + REPLAN_RETRY_COOLDOWN_MS;
        latest.setTransitRerouteNeeded(false);
      }
    } catch {
      nextReplanAllowedAtRef.current = Date.now() + REPLAN_RETRY_COOLDOWN_MS;
      useNavigationStore.getState().setTransitRerouteNeeded(false);
    } finally {
      replanningRef.current = false;
    }
  }, []);

  const onFix = useCallback(
    (fix: FixInput) => {
      const store = useNavigationStore.getState();
      const { status, kind, itinerary } = store;
      if (status !== "navigating" || kind !== "transit" || !itinerary) return;

      const tp = computeTransitProgress(itinerary, fix.coords);
      store.applyTransitProgress(tp);

      if (map) {
        map.easeTo(
          { center: tp.snapped, zoom: Math.max(map.getZoom(), 15), duration: 350 },
          { programmatic: true },
        );
      }

      if (tp.arrived) {
        haptics.success();
        store.completeArrival();
        return;
      }

      // On-trip reroute: if we've missed an upcoming connection, replan from
      // here to the original destination (the last leg's drop-off point).
      if (
        !store.transitRerouteNeeded &&
        Date.now() >= nextReplanAllowedAtRef.current &&
        detectMissedConnection(itinerary, tp, Date.now())
      ) {
        const legs = itinerary.legs ?? [];
        const dest = legs[legs.length - 1]?.to;
        if (dest) void replan(fix.coords, [dest.lng, dest.lat]);
      }
    },
    [map, replan],
  );

  const active = useNavigationStore(
    (s) => s.status !== "idle" && s.status !== "arrived" && s.kind === "transit",
  );
  useWatchPosition(active, onFix);
}
