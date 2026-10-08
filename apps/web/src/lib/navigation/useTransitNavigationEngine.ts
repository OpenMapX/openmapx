import {
  API_ENDPOINTS,
  apiClient,
  type FixInput,
  type PreparedTransitProgress,
  prepareTransitProgress,
  useNavigationStore,
  useTransitStopAreas,
} from "@openmapx/core";
import {
  DEFAULT_TRANSIT_TICK_OPTIONS,
  freshTransitTickState,
  processTransitFix,
  type TransitStopAreaIndex,
  type TransitTickState,
  transitItineraryFingerprint,
  transitProgressFromTick,
} from "@openmapx/core/navigation";
import type { MobilityEnvelope } from "@openmapx/mobility-core/result";
import type { TripItinerary, TripPlan } from "@openmapx/mobility-core/transit";
import { useCallback, useEffect, useRef } from "react";
import { useMapOptional } from "@/integration-api/map/MapContext";
import { haptics } from "../haptics";
import { useWatchPosition } from "../useWatchPosition";

/**
 * Transit follow-along engine for the browser. Feeds GPS fixes through the
 * same stateful `processTransitFix` the app shell runs — which holds the
 * current leg, treats stops as the areas a rider enters, and never jumps
 * backwards — and publishes what it decided as `transitProgress`. When the
 * engine reports a missed connection it performs an on-trip replan: it
 * re-queries MOTIS from the current position to the original destination and
 * swaps in the new itinerary.
 */
/** Cooldown after a replan before another missed-connection retry may fire. */
const REPLAN_RETRY_COOLDOWN_MS = 30_000;

export function useTransitNavigationEngine(): void {
  const map = useMapOptional()?.mapRef.current ?? null;
  // Guards against firing overlapping replans while one is in flight.
  const replanningRef = useRef<{ requestId: string; lifecycle: object } | null>(null);
  const lifecycleRef = useRef<object | null>({});
  useEffect(() => {
    lifecycleRef.current = {};
    return () => {
      lifecycleRef.current = null;
      const store = useNavigationStore.getState();
      if (replanningRef.current?.requestId === store.transitRequestId) {
        store.setTransitRerouteNeeded(false);
      }
    };
  }, []);
  // Earliest time a replan may retry after a failure, so a persistently failing
  // replan (destination temporarily unreachable, offline) doesn't fire on every
  // ~1Hz fix and storm the BFF.
  const nextReplanAllowedAtRef = useRef({ requestId: null as string | null, until: 0 });
  // The planned trip's per-leg snap indexes. They describe the itinerary, so
  // they outlive every fix and are rebuilt only when a replan swaps the
  // itinerary in. A ref, because the fix handler reads it from the store.
  const preparedRef = useRef<PreparedTransitProgress | null>(null);
  // The engine's state belongs to one trip. A realtime refresh swaps in a new
  // itinerary object for the same trip and must keep it; a replan is a new
  // trip and starts afresh — so it is keyed by the structural fingerprint.
  const tickRef = useRef<{
    itinerary: TripItinerary;
    fingerprint: string;
    state: TransitTickState;
  } | null>(null);
  // Stop shapes arrive after the trip starts; until then each stop is a circle.
  const itinerary = useNavigationStore((s) => s.itinerary);
  const stopAreas = useTransitStopAreas(itinerary);
  const stopAreasRef = useRef<TransitStopAreaIndex>(stopAreas);
  stopAreasRef.current = stopAreas;

  // The engine asks for a replan once per leg; after one that found nothing it
  // must be allowed to ask again, once the cooldown has passed.
  const rearmReplan = useCallback(() => {
    const tick = tickRef.current;
    if (tick) tick.state = { ...tick.state, replanRequestedForLeg: undefined };
  }, []);

  const replan = useCallback(
    async (from: [number, number], to: [number, number]) => {
      const initial = useNavigationStore.getState();
      const requestId = initial.transitRequestId;
      const lifecycle = lifecycleRef.current;
      if (!requestId || !lifecycle || replanningRef.current?.requestId === requestId) return;
      const flight = { requestId, lifecycle };
      replanningRef.current = flight;
      const ownsRequest = () => {
        const current = useNavigationStore.getState();
        return (
          lifecycleRef.current === lifecycle &&
          current.transitRequestId === requestId &&
          current.status === "navigating" &&
          current.kind === "transit"
        );
      };
      initial.setTransitRerouteNeeded(true);
      try {
        // Reuse the user's original transit options, snapshotted into the
        // navigation store when the trip started (preferred modes, the
        // Deutschlandticket-filtered set, wheelchair, first/last-mile access).
        // Reading the snapshot — not the live directions store, which close()
        // resets to defaults — keeps the replan from silently routing onto
        // excluded/inaccessible legs, and respects the Germany-only D-Ticket gate
        // exactly as it was applied at planning time.
        const opts = initial.transitReplanOptions;
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
        if (opts?.deutschlandticketOnly) params.deutschlandticket = "true";

        const env = await apiClient.get<MobilityEnvelope<TripPlan>>(
          API_ENDPOINTS.transitPlan,
          params,
        );
        const next = env.data?.itineraries?.[0];
        const latest = useNavigationStore.getState();
        if (!ownsRequest()) return;
        if (next) {
          haptics.warn();
          // Back off after a successful replan too: the fresh itinerary's first
          // transit leg may still read as "missed" when no better option exists,
          // and replaceItinerary clears transitRerouteNeeded — without a cooldown
          // the next fix would re-fire the replan every ~1Hz and storm the BFF.
          nextReplanAllowedAtRef.current = {
            requestId,
            until: Date.now() + REPLAN_RETRY_COOLDOWN_MS,
          };
          latest.replaceItinerary(next);
          nextReplanAllowedAtRef.current.requestId = useNavigationStore.getState().transitRequestId;
        } else {
          // No alternative: back off before the next missed-connection retry.
          nextReplanAllowedAtRef.current = {
            requestId,
            until: Date.now() + REPLAN_RETRY_COOLDOWN_MS,
          };
          latest.setTransitRerouteNeeded(false);
          rearmReplan();
        }
      } catch {
        if (!ownsRequest()) return;
        nextReplanAllowedAtRef.current = {
          requestId,
          until: Date.now() + REPLAN_RETRY_COOLDOWN_MS,
        };
        useNavigationStore.getState().setTransitRerouteNeeded(false);
        rearmReplan();
      } finally {
        if (replanningRef.current === flight) replanningRef.current = null;
      }
    },
    [rearmReplan],
  );

  const onFix = useCallback(
    (fix: FixInput) => {
      const store = useNavigationStore.getState();
      const { status, kind, itinerary } = store;
      if (status !== "navigating" || kind !== "transit" || !itinerary) return;

      const held = preparedRef.current;
      // Dropping the reference releases the previous itinerary's indexes.
      const prepared = held?.itinerary === itinerary ? held : prepareTransitProgress(itinerary);
      preparedRef.current = prepared;

      const nowMs = Date.now();
      const tick = tickRef.current;
      const fingerprint =
        tick?.itinerary === itinerary ? tick.fingerprint : transitItineraryFingerprint(itinerary);
      const state = tick?.fingerprint === fingerprint ? tick.state : freshTransitTickState(nowMs);
      const result = processTransitFix({
        itinerary,
        captures: [],
        state,
        fix,
        nowMs,
        options: {
          ...DEFAULT_TRANSIT_TICK_OPTIONS,
          itineraryFingerprint: fingerprint,
        },
        prepared,
        stopAreas: stopAreasRef.current,
      });
      tickRef.current = { itinerary, fingerprint, state: result.state };

      const tp = transitProgressFromTick(result.state, prepared, fix.coords);
      store.applyTransitProgress(tp);

      // Follow the snapped position unless the user has released the camera
      // (e.g. via "Overview"); the MapControls recenter compass sets it back.
      if (map && store.cameraMode === "follow") {
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

      // On-trip reroute: the engine reports a missed connection once per leg;
      // replan from here to the original destination (the last leg's drop-off
      // point). While a replan is in flight or backing off, let the engine ask
      // again on a later fix, so a failed attempt is retried after the cooldown.
      if (!result.needsReplan) return;
      const mayReplan =
        !store.transitRerouteNeeded &&
        (nextReplanAllowedAtRef.current.requestId !== store.transitRequestId ||
          nowMs >= nextReplanAllowedAtRef.current.until);
      const dest = itinerary.legs?.at(-1)?.to;
      if (mayReplan && dest) void replan(fix.coords, [dest.lng, dest.lat]);
      else rearmReplan();
    },
    [map, replan, rearmReplan],
  );

  const active = useNavigationStore(
    (s) => s.status !== "idle" && s.status !== "arrived" && s.kind === "transit",
  );
  useWatchPosition(active, onFix);
}
