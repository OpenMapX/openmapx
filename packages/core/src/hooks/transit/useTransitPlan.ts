import type { MobilityEnvelope } from "@openmapx/mobility-core/result";
import type { TripPlan } from "@openmapx/mobility-core/transit";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../../api/client";
import { API_ENDPOINTS } from "../../api/endpoints";
import type { LngLat } from "../../types/geometry";
import { type MobilityEnvelopeQueryResult, wrapMobilityEnvelope } from "./useMobilityEnvelope";

interface UseTransitPlanParams {
  origin: LngLat | null;
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
  wheelchair?: boolean;
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
  departAt,
  arriveBy,
  numItineraries,
  lang,
  modes,
  wheelchair,
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
  // Stable, order-independent key for the modes allow-list so toggling the same
  // set in a different order reuses the cached query.
  const modesKey = modes && modes.length > 0 ? [...modes].sort().join(",") : undefined;
  const preKey = preTransitModes?.length ? [...preTransitModes].sort().join(",") : undefined;
  const postKey = postTransitModes?.length ? [...postTransitModes].sort().join(",") : undefined;
  const directKey = directModes?.length ? [...directModes].sort().join(",") : undefined;
  const rentalFormFactorsKey = rentalFormFactors?.length
    ? [...new Set(rentalFormFactors)].sort().join(",")
    : undefined;
  // When no explicit time is set, floor "now" to the current minute so that
  // React Query can serve cached results for up to staleTime (2 min) instead
  // of treating every refetch as a new query due to a fresh timestamp.
  const effectiveTime = arriveBy ?? departAt ?? floorToMinute(new Date().toISOString());

  const query = useQuery({
    queryKey: [
      "transit-plan",
      origin,
      destination,
      effectiveTime,
      !!arriveBy,
      numItineraries,
      lang,
      modesKey,
      !!wheelchair,
      !!wheelchairRequired,
      maxTransfers,
      transferBuffer,
      !!requireBikeTransport,
      bikeHillPreference,
      rentalFormFactorsKey,
      preKey,
      postKey,
      directKey,
      !!deutschlandticketOnly,
      pageToken,
      capabilityEpoch,
      rentalSource,
      rentalInstance,
    ],
    queryFn: () => {
      if (!origin || !destination) throw new Error("Origin and destination required");
      const params: Record<string, string> = {
        from_lat: String(origin[1]),
        from_lng: String(origin[0]),
        to_lat: String(destination[1]),
        to_lng: String(destination[0]),
        time: effectiveTime,
      };
      if (arriveBy) {
        params.arrive_by = "true";
      }
      if (numItineraries && numItineraries !== 3) {
        params.num_itineraries = String(numItineraries);
      }
      if (lang) {
        params.lang = lang;
      }
      if (modesKey) {
        params.modes = modesKey;
      }
      if (wheelchair || wheelchairRequired) {
        params.wheelchair = "true";
      }
      if (maxTransfers !== undefined) params.max_transfers = String(maxTransfers);
      if (transferBuffer && transferBuffer !== "standard") {
        params.transfer_buffer = transferBuffer;
      }
      if (requireBikeTransport) params.require_bike_transport = "true";
      if (bikeHillPreference && bikeHillPreference !== "default") {
        params.bike_hill_preference = bikeHillPreference;
      }
      if (rentalFormFactorsKey) params.rental_form_factors = rentalFormFactorsKey;
      if (preKey) {
        params.pre_modes = preKey;
      }
      if (postKey) {
        params.post_modes = postKey;
      }
      if (directKey) {
        params.direct_modes = directKey;
      }
      if (deutschlandticketOnly) {
        params.deutschlandticket = "true";
      }
      if (pageToken) params.page_token = pageToken;
      if (capabilityEpoch) params.capability_epoch = capabilityEpoch;
      if (rentalSource) params.rental_source = rentalSource;
      if (rentalInstance) params.rental_instance = rentalInstance;
      return apiClient.get<MobilityEnvelope<TripPlan>>(API_ENDPOINTS.transitPlan, params);
    },
    enabled: origin !== null && destination !== null,
    staleTime: 120_000,
    gcTime: 600_000,
  });
  return wrapMobilityEnvelope(query);
}
