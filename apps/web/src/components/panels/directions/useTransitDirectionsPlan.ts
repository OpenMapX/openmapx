"use client";

import type { DirectionsState, TransitReplanOptions } from "@openmapx/core";
import {
  preferredModesToMotis,
  TRANSIT_ACCESS_MOTIS_MODES,
  TRANSIT_ACCESS_RENTAL_FORM_FACTORS,
  useDebounce,
  useDirectionsStore,
  useRouteInGermany,
  useTransitChainPlan,
  useTransitPlan,
  useTransitPlanningCapabilities,
} from "@openmapx/core";
import { contributorsForRecords } from "@openmapx/mobility-core/contributors";
import { useEffect, useMemo, useState } from "react";
import { mergeTransitItineraryPage } from "./transitPlanPages";

export type TransitDirectionsSnapshot = Pick<
  DirectionsState,
  | "waypoints"
  | "transitDepartureTime"
  | "transitArrivalTime"
  | "transitPreferredModes"
  | "transitRoutePreference"
  | "transitAccessMode"
  | "wheelchairRequired"
  | "maxTransfers"
  | "transferBuffer"
  | "requireBikeTransport"
  | "bikeHillPreference"
  | "deutschlandticketOnly"
> & { enabled: boolean; timeMode: "now" | "depart" | "arrive" };

/** Composes existing transit acquisition, page publication and captured navigation policy. */
export function useTransitDirectionsPlan({
  enabled,
  timeMode,
  waypoints,
  transitDepartureTime,
  transitArrivalTime,
  transitPreferredModes,
  transitRoutePreference,
  transitAccessMode,
  wheelchairRequired,
  maxTransfers,
  transferBuffer,
  requireBikeTransport,
  bikeHillPreference,
  deutschlandticketOnly,
}: TransitDirectionsSnapshot) {
  const origin = waypoints[0]?.coords ?? null;
  const destination = waypoints.at(-1)?.coords ?? null;
  const routeWaypoints = useMemo(
    () => waypoints.flatMap((wp) => (wp.coords ? [wp.coords] : [])),
    [waypoints],
  );
  const allWaypointsFilled = routeWaypoints.length === waypoints.length && waypoints.length >= 2;
  const itineraries = useDirectionsStore((s) => s.transitItineraries);
  const setTransitItineraries = useDirectionsStore((s) => s.setTransitItineraries);
  const { data: transitPlanningCapabilities } = useTransitPlanningCapabilities();
  const [transitPageToken, setTransitPageToken] = useState<string | undefined>();
  const [transitPageDirection, setTransitPageDirection] = useState<"previous" | "next">("next");
  // Transit plan query
  const debouncedDepartureTime = useDebounce(transitDepartureTime, 500);
  const debouncedArrivalTime = useDebounce(transitArrivalTime, 500);
  const transitDepartAtStr =
    enabled && timeMode === "depart" && debouncedDepartureTime instanceof Date
      ? debouncedDepartureTime.toISOString()
      : undefined;
  const transitArriveByStr =
    enabled && timeMode === "arrive" && debouncedArrivalTime instanceof Date
      ? debouncedArrivalTime.toISOString()
      : undefined;

  // "Fewer transfers" / "Less walking" re-rank the returned Pareto front, so
  // fetch a few extra alternatives to give the sort something to choose from.
  const ranksClientSide =
    transitRoutePreference === "fewerTransfers" || transitRoutePreference === "lessWalking";
  const effectiveNumItineraries = ranksClientSide ? 5 : 3;

  // The Deutschlandticket filter is Germany-only; gate it on both endpoints
  // resolving to DE so we never silently constrain a route that leaves Germany.
  // Only resolve the endpoints' country when the toggle is actually on —
  // bothInGermany is consumed solely by deutschlandticketActive below, so an
  // off toggle must not fire two reverse-geocodes per transit route. (The
  // options panel resolves it separately to decide whether to show the toggle.)
  const { bothInGermany } = useRouteInGermany(
    enabled && deutschlandticketOnly ? origin : null,
    enabled && deutschlandticketOnly ? destination : null,
  );
  const deutschlandticketActive = enabled && bothInGermany && deutschlandticketOnly;

  // Send the user's raw Prefer selection plus a Deutschlandticket flag; each
  // transit provider applies the D-Ticket restriction its own (most accurate)
  // way server-side (MOTIS intersects modes, db-vendo uses DB's native filter).
  const effectiveMotisModes = useMemo(
    () => preferredModesToMotis(transitPreferredModes),
    [transitPreferredModes],
  );

  const accessModes = TRANSIT_ACCESS_MOTIS_MODES[transitAccessMode];
  const rentalFormFactors = TRANSIT_ACCESS_RENTAL_FORM_FACTORS[transitAccessMode];
  const activePlanningMetadata = transitPlanningCapabilities?.providers.find(
    (provider) => provider.id === "transit-motis-local",
  )?.metadata;

  // Snapshot of the resolved MOTIS options to hand to navigation, so an on-trip
  // replan reuses the same modes/access/wheelchair/D-Ticket gate the plan used.
  const transitReplanOptions = useMemo<TransitReplanOptions>(
    () => ({
      modes: effectiveMotisModes,
      wheelchairRequired,
      maxTransfers: maxTransfers ?? undefined,
      transferBuffer,
      requireBikeTransport,
      bikeHillPreference,
      preTransitModes: accessModes.preTransitModes,
      postTransitModes: accessModes.postTransitModes,
      directModes: accessModes.directModes,
      deutschlandticketOnly: deutschlandticketActive,
    }),
    [
      effectiveMotisModes,
      wheelchairRequired,
      maxTransfers,
      transferBuffer,
      requireBikeTransport,
      bikeHillPreference,
      accessModes,
      deutschlandticketActive,
    ],
  );

  // A transit journey with intermediate stops — or with any stop time — is a
  // chain of connections, one per segment; the point-to-point planner cannot
  // express it, so exactly one of the two queries runs.
  const transitIsChained =
    enabled &&
    allWaypointsFilled &&
    (waypoints.length > 2 || waypoints.some((wp) => wp.schedule !== undefined));

  const transitChainRequest = useMemo(
    () =>
      transitIsChained
        ? {
            waypoints: routeWaypoints.map(([lng, lat]) => ({ lat, lng })),
            schedules: waypoints.map((wp) => wp.schedule ?? null),
            ...(transitDepartAtStr ? { departureTime: transitDepartAtStr } : {}),
            ...(transitArriveByStr ? { arrivalTime: transitArriveByStr } : {}),
            modes: effectiveMotisModes,
            wheelchairRequired,
            ...(maxTransfers !== null ? { maxTransfers } : {}),
            transferBuffer,
            requireBikeTransport,
            bikeHillPreference,
            preTransitModes: accessModes.preTransitModes,
            postTransitModes: accessModes.postTransitModes,
            directModes: accessModes.directModes,
            deutschlandticketOnly: deutschlandticketActive,
            ...(activePlanningMetadata?.datasetEpoch
              ? { capabilityEpoch: activePlanningMetadata.datasetEpoch }
              : {}),
          }
        : null,
    [
      transitIsChained,
      routeWaypoints,
      waypoints,
      transitDepartAtStr,
      transitArriveByStr,
      effectiveMotisModes,
      wheelchairRequired,
      maxTransfers,
      transferBuffer,
      requireBikeTransport,
      bikeHillPreference,
      accessModes,
      deutschlandticketActive,
      activePlanningMetadata,
    ],
  );
  const transitChainQuery = useTransitChainPlan(transitChainRequest);

  const transitPlanQuery = useTransitPlan({
    origin: enabled && !transitIsChained ? origin : null,
    destination: enabled && !transitIsChained ? destination : null,
    departAt: transitDepartAtStr,
    arriveBy: transitArriveByStr,
    numItineraries: effectiveNumItineraries,
    modes: effectiveMotisModes,
    wheelchairRequired,
    maxTransfers: maxTransfers ?? undefined,
    transferBuffer,
    requireBikeTransport,
    bikeHillPreference,
    rentalFormFactors,
    capabilityEpoch: activePlanningMetadata?.datasetEpoch,
    rentalSource: rentalFormFactors ? activePlanningMetadata?.source : undefined,
    rentalInstance: rentalFormFactors ? activePlanningMetadata?.instance : undefined,
    preTransitModes: accessModes.preTransitModes,
    postTransitModes: accessModes.postTransitModes,
    directModes: accessModes.directModes,
    deutschlandticketOnly: deutschlandticketActive,
    pageToken: transitPageToken,
  });
  const { data: transitPlanData } = transitPlanQuery;
  const attributions = contributorsForRecords(itineraries);
  useEffect(() => {
    if (!transitPlanData?.itineraries) return;
    setTransitItineraries(
      mergeTransitItineraryPage({
        existing: transitPageToken ? useDirectionsStore.getState().transitItineraries : [],
        incoming: transitPlanData.itineraries,
        provider: transitPlanData.provider,
        page: transitPageToken ? transitPageDirection : "initial",
        preference: transitRoutePreference,
      }),
    );
  }, [
    transitPlanData,
    transitRoutePreference,
    setTransitItineraries,
    transitPageToken,
    transitPageDirection,
  ]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional trigger deps
  useEffect(() => {
    setTransitPageToken(undefined);
  }, [origin, destination]);

  return {
    isChained: transitIsChained,
    planQuery: transitPlanQuery,
    chainQuery: transitChainQuery,
    itineraries,
    replanOptions: transitReplanOptions,
    attributions,
    paging: {
      isPage: Boolean(transitPageToken),
      previousToken: transitPlanData?.previousPageToken,
      nextToken: transitPlanData?.nextPageToken,
      loadPrevious: () => {
        if (!transitPlanData?.previousPageToken) return;
        setTransitPageDirection("previous");
        setTransitPageToken(transitPlanData.previousPageToken);
      },
      loadNext: () => {
        if (!transitPlanData?.nextPageToken) return;
        setTransitPageDirection("next");
        setTransitPageToken(transitPlanData.nextPageToken);
      },
    },
  };
}
