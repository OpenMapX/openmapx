import type { TripPlan } from "@openmapx/mobility-core/transit";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import {
  fetchReferencedTransitPlan,
  fetchTransitPlan,
  type TransitPlanParams,
  type TransitReferenceParams,
  transitPlanQueryKey,
} from "../../api/transit";
import type { LngLat } from "../../types/geometry";
import { type MobilityEnvelopeQueryResult, wrapMobilityEnvelope } from "./useMobilityEnvelope";

interface UseTransitPlanParams {
  origin: LngLat | null;
  enabled?: boolean;
  reference?: TransitReferenceParams | null;
  destination: LngLat | null;
  /** ISO 8601 timestamp — desired departure time. Mutually exclusive with arriveBy. */
  departAt?: string;
  /** ISO 8601 timestamp — desired arrival time. When set, sends arrive_by=true to the API. */
  arriveBy?: string;
  /** Number of itineraries to fetch (1–10, default 3). */
  numItineraries?: number;
  /** Language for localized responses (e.g. "en", "de"). */
  lang?: string;
  /** MOTIS `transitModes` allow-list (e.g. ["BUS", "TRAM"]). Omit for all modes. */
  modes?: string[];
  /** When true, requests wheelchair-accessible routing (MOTIS pedestrianProfile=WHEELCHAIR). */
  wheelchairRequired?: boolean;
  maxTransfers?: number;
  transferBuffer?: "standard" | "relaxed" | "extra";
  requireBikeTransport?: boolean;
  bikeHillPreference?: "default" | "avoid" | "strongly-avoid";
  rentalFormFactors?: string[];
  /** MOTIS first-mile access modes (e.g. ["BIKE"], ["CAR_PARKING"]). */
  preTransitModes?: string[];
  /** MOTIS last-mile egress modes. */
  postTransitModes?: string[];
  /** MOTIS direct (door-to-door) modes; adds non-transit options to the result. */
  directModes?: string[];
  /** Restrict results to Deutschlandticket-valid (regional/local) connections. */
  deutschlandticketOnly?: boolean;
  /** Signed OpenMapX paging token; never an upstream cursor. */
  pageToken?: string;
  capabilityEpoch?: string;
  rentalSource?: string;
  rentalInstance?: string;
}

/** Floor a Date to the nearest minute so queries within the same minute share a cache key. */
function floorToMinute(iso: string): string {
  return `${iso.slice(0, 16)}:00Z`;
}

export function useTransitPlan({
  origin,
  destination,
  enabled = true,
  reference,
  departAt,
  arriveBy,
  numItineraries,
  lang,
  modes,
  wheelchairRequired,
  maxTransfers,
  transferBuffer,
  requireBikeTransport,
  bikeHillPreference,
  rentalFormFactors,
  preTransitModes,
  postTransitModes,
  directModes,
  deutschlandticketOnly,
  pageToken,
  capabilityEpoch,
  rentalSource,
  rentalInstance,
}: UseTransitPlanParams): MobilityEnvelopeQueryResult<TripPlan> {
  // When no explicit time is set, floor "now" to the current minute so that
  // React Query can serve cached results for up to staleTime (2 min) instead
  // of treating every refetch as a new query due to a fresh timestamp.
  const explicitTime = arriveBy ?? departAt;
  const unpagedTime = explicitTime ?? floorToMinute(new Date().toISOString());
  // A page token is signed against the request that issued it, time included.
  // Earlier/later requests therefore reuse the minute the unpaged search ran at
  // instead of drifting to the current one; a fresh unpaged search re-anchors.
  const [retainedTime, setRetainedTime] = useState(unpagedTime);
  if (!pageToken && retainedTime !== unpagedTime) setRetainedTime(unpagedTime);
  const effectiveTime = pageToken && !explicitTime ? retainedTime : unpagedTime;

  const search: TransitPlanParams | undefined =
    origin && destination
      ? {
          origin,
          destination,
          time: effectiveTime,
          arriveBy: Boolean(arriveBy),
          numItineraries,
          lang,
          modes,
          wheelchairRequired,
          maxTransfers,
          transferBuffer,
          requireBikeTransport,
          bikeHillPreference,
          rentalFormFactors,
          preTransitModes,
          postTransitModes,
          directModes,
          deutschlandticketOnly,
          pageToken,
          capabilityEpoch,
          rentalSource,
          rentalInstance,
        }
      : undefined;
  const query = useQuery({
    queryKey: reference
      ? transitPlanQueryKey({ kind: "reference", params: reference })
      : search
        ? transitPlanQueryKey({ kind: "search", params: search })
        : ["transit-plan", "incomplete", origin, destination, effectiveTime],
    queryFn: ({ signal }) => {
      if (reference) return fetchReferencedTransitPlan(reference, undefined, { signal });
      if (!search) throw new Error("Origin and destination required");
      return fetchTransitPlan(search, undefined, { signal });
    },
    enabled: enabled && origin !== null && destination !== null,
    staleTime: 120_000,
    gcTime: 600_000,
  });
  return wrapMobilityEnvelope(query);
}
