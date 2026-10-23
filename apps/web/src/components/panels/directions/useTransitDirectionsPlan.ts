"use client";

import type { DirectionsState, TransitReplanOptions } from "@openmapx/core";
import {
  buildTransitPlanParams,
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

/** Paging state owned by exactly one routing query; a different query never inherits it. */
interface TransitPagingOwner {
  identity: string;
  token?: string;
  direction: "previous" | "next";
}

/** Raw (undebounced) value of the time the active mode edits, so edits retire paging at once. */
function rawTimeIdentity(value: "now" | Date | null): string | number | null {
  return value instanceof Date ? value.getTime() : value;
}

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

  const planningActive = enabled && !transitIsChained && origin !== null && destination !== null;
  const planArgs = {
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
  };

  // Page tokens are signed against the query that issued them, so paging belongs
  // to that query's canonical request. The serializer collapses equivalent
  // coordinates and option lists; an implicit time is a marker because the hook
  // owns the actual minute it anchors to.
  const pagingIdentity =
    planningActive && origin && destination
      ? JSON.stringify([
          buildTransitPlanParams({
            origin,
            destination,
            time: transitArriveByStr ?? transitDepartAtStr ?? "now",
            arriveBy: transitArriveByStr !== undefined,
            ...planArgs,
          }),
          timeMode,
          rawTimeIdentity(
            timeMode === "depart"
              ? transitDepartureTime
              : timeMode === "arrive"
                ? transitArrivalTime
                : null,
          ),
        ])
      : "inactive";
  const [storedPaging, setStoredPaging] = useState<TransitPagingOwner>({
    identity: pagingIdentity,
    direction: "next",
  });
  // Retire a previous query's paging synchronously: an effect would first let one
  // render and request pair the changed inputs with the old token.
  let paging = storedPaging;
  if (storedPaging.identity !== pagingIdentity) {
    paging = { identity: pagingIdentity, direction: "next" };
    setStoredPaging(paging);
  }
  const transitPageToken = paging.token;
  const transitPageDirection = paging.direction;
  const loadPage = (direction: "previous" | "next", token: string | undefined) => {
    if (!planningActive || !token) return;
    // Only the rendered owner may advance; callbacks from an earlier query or page no-op.
    setStoredPaging((current) =>
      current === paging ? { identity: paging.identity, token, direction } : current,
    );
  };

  const transitPlanQuery = useTransitPlan({
    origin: enabled && !transitIsChained ? origin : null,
    destination: enabled && !transitIsChained ? destination : null,
    departAt: transitDepartAtStr,
    arriveBy: transitArriveByStr,
    ...planArgs,
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
      loadPrevious: () => loadPage("previous", transitPlanData?.previousPageToken),
      loadNext: () => loadPage("next", transitPlanData?.nextPageToken),
    },
  };
}
