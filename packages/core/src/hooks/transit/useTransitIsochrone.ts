import type { MobilityEnvelope } from "@openmapx/mobility-core/result";
import type {
  TransitIsochroneRequest,
  TransitIsochroneResult,
} from "@openmapx/mobility-core/transit-isochrone";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../../api/client";
import { API_ENDPOINTS } from "../../api/endpoints";
import { type MobilityEnvelopeQueryResult, wrapMobilityEnvelope } from "./useMobilityEnvelope";

export function transitIsochroneKey(request: TransitIsochroneRequest | null) {
  return ["transit-isochrone", request] as const;
}

/**
 * Sampled, exportable transit isochrone polygons.
 *
 * Disabled by default and never refetched on focus: one call issues many
 * sequential MOTIS batches, so it must be driven by an explicit user action
 * rather than by pan, zoom, or window focus.
 */
export function useTransitIsochrone(
  request: TransitIsochroneRequest | null,
  enabled = false,
): MobilityEnvelopeQueryResult<TransitIsochroneResult> {
  const query = useQuery({
    queryKey: transitIsochroneKey(request),
    queryFn: ({ signal }) => {
      if (!request) throw new Error("Transit isochrone request required");
      return apiClient.post<MobilityEnvelope<TransitIsochroneResult>>(
        API_ENDPOINTS.transitReachabilityIsochrone,
        request,
        { signal, timeoutMs: 70_000 },
      );
    },
    enabled: enabled && request !== null,
    staleTime: 900_000,
    gcTime: 1_800_000,
    retry: false,
    refetchOnWindowFocus: false,
  });
  return wrapMobilityEnvelope(query);
}
