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
}: UseTransitPlanParams): MobilityEnvelopeQueryResult<TripPlan> {
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
      return apiClient.get<MobilityEnvelope<TripPlan>>(API_ENDPOINTS.transitPlan, params);
    },
    enabled: origin !== null && destination !== null,
    staleTime: 120_000,
    gcTime: 600_000,
  });
  return wrapMobilityEnvelope(query);
}
