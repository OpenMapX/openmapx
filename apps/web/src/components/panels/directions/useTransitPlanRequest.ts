"use client";

import type { TransitReplanOptions } from "@openmapx/core";
import {
  preferredModesToMotis,
  TRANSIT_ACCESS_MOTIS_MODES,
  TRANSIT_ACCESS_RENTAL_FORM_FACTORS,
  useDebounce,
  useRouteInGermany,
  useTransitPlanningCapabilities,
} from "@openmapx/core";
import { useMemo } from "react";
import type { TransitDirectionsSnapshot } from "./useTransitDirectionsPlan";

/**
 * The dataset a plan is made against: the metadata of the first planner, in
 * the operator's order, that reports any. Whichever planner that is, its
 * epoch binds the plan and its rental source names the rental filters.
 */
export function transitPlanningMetadata<M>(
  capabilities: { providers: readonly { id: string; metadata?: M }[] } | undefined,
): M | undefined {
  return capabilities?.providers.find((provider) => provider.metadata)?.metadata;
}

/**
 * Resolves the directions panel's transit settings into what the planners are
 * asked: the debounced times, the MOTIS modes and access legs, the
 * Deutschlandticket gate, and whether the trip is a chain of connections.
 */
export function useTransitPlanRequest({
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
  const { data: transitPlanningCapabilities } = useTransitPlanningCapabilities();
  const debouncedDepartureTime = useDebounce(transitDepartureTime, 500);
  const debouncedArrivalTime = useDebounce(transitArrivalTime, 500);
  const departAt =
    enabled && timeMode === "depart" && debouncedDepartureTime instanceof Date
      ? debouncedDepartureTime.toISOString()
      : undefined;
  const arriveBy =
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
  // way server-side (MOTIS intersects modes; providers that can't step aside).
  const effectiveMotisModes = useMemo(
    () => preferredModesToMotis(transitPreferredModes),
    [transitPreferredModes],
  );

  const accessModes = TRANSIT_ACCESS_MOTIS_MODES[transitAccessMode];
  const rentalFormFactors = TRANSIT_ACCESS_RENTAL_FORM_FACTORS[transitAccessMode];
  const activePlanningMetadata = transitPlanningMetadata(transitPlanningCapabilities);

  // Snapshot of the resolved MOTIS options to hand to navigation, so an on-trip
  // replan reuses the same modes/access/wheelchair/D-Ticket gate the plan used.
  const replanOptions = useMemo<TransitReplanOptions>(
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
  const isChained =
    enabled &&
    allWaypointsFilled &&
    (waypoints.length > 2 || waypoints.some((wp) => wp.schedule !== undefined));

  const chainRequest = useMemo(
    () =>
      isChained
        ? {
            waypoints: routeWaypoints.map(([lng, lat]) => ({ lat, lng })),
            schedules: waypoints.map((wp) => wp.schedule ?? null),
            ...(departAt ? { departureTime: departAt } : {}),
            ...(arriveBy ? { arrivalTime: arriveBy } : {}),
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
      isChained,
      routeWaypoints,
      waypoints,
      departAt,
      arriveBy,
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

  return {
    origin,
    destination,
    /** The debounced departure time, set only while transit plans a depart-at trip. */
    departAt,
    /** The debounced arrival time, set only while transit plans an arrive-by trip. */
    arriveBy,
    isChained,
    chainRequest,
    /** The point-to-point planner's options, without endpoints, time or page. */
    planArgs,
    replanOptions,
  };
}
