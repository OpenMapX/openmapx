import type { MobilityEnvelope } from "@openmapx/mobility-core/result";
import type { TransitStop } from "@openmapx/mobility-core/transit";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../../api/client";
import { API_ENDPOINTS } from "../../api/endpoints";
import type { LngLat } from "../../types/geometry";
import { type MobilityEnvelopeQueryResult, wrapMobilityEnvelope } from "./useMobilityEnvelope";

interface UseReachableStopsParams {
  origin: LngLat | null;
  /** Travel-time budget in minutes (MOTIS caps at the server `onetoall_max_travel_minutes`). */
  maxMinutes?: number;
  /** MOTIS `transitModes` allow-list (e.g. ["BUS", "TRAM"]). Omit for all modes. */
  modes?: string[];
  enabled?: boolean;
}

/**
 * Stops reachable from `origin` within `maxMinutes` by transit, via the MOTIS
 * one-to-all endpoint (backend `/reachable`). Each {@link TransitStop} carries
 * `reachMinutes`/`reachTransfers`, so consumers can colour stops by time band
 * to render a transit reachability / isochrone overlay.
 */
export function useReachableStops({
  origin,
  maxMinutes = 30,
  modes,
  enabled = true,
}: UseReachableStopsParams): MobilityEnvelopeQueryResult<TransitStop[]> {
  const modesKey = modes && modes.length > 0 ? [...modes].sort().join(",") : undefined;

  const query = useQuery({
    queryKey: ["transit-reachable", origin, maxMinutes, modesKey],
    queryFn: () => {
      if (!origin) throw new Error("Origin required");
      const params: Record<string, string> = {
        lat: String(origin[1]),
        lng: String(origin[0]),
        maxTravelTime: String(maxMinutes),
      };
      if (modesKey) params.modes = modesKey;
      return apiClient.get<MobilityEnvelope<TransitStop[]>>(API_ENDPOINTS.transitReachable, params);
    },
    enabled: enabled && origin !== null,
    staleTime: 300_000,
    gcTime: 600_000,
  });
  return wrapMobilityEnvelope(query);
}
