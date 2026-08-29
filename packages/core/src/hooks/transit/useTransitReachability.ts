import type { MobilityEnvelope } from "@openmapx/mobility-core/result";
import type {
  TransitReachabilitySurface,
  TransitReachabilitySurfaceRequest,
} from "@openmapx/mobility-core/transit-reachability";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../../api/client";
import { API_ENDPOINTS } from "../../api/endpoints";
import { type MobilityEnvelopeQueryResult, wrapMobilityEnvelope } from "./useMobilityEnvelope";

export function transitReachabilitySurfaceKey(request: TransitReachabilitySurfaceRequest | null) {
  return ["transit-reachability-surface", request] as const;
}

export function useTransitReachability(
  request: TransitReachabilitySurfaceRequest | null,
  enabled = true,
): MobilityEnvelopeQueryResult<TransitReachabilitySurface> {
  const query = useQuery({
    queryKey: transitReachabilitySurfaceKey(request),
    queryFn: ({ signal }) => {
      if (!request) throw new Error("Transit reachability request required");
      return apiClient.post<MobilityEnvelope<TransitReachabilitySurface>>(
        API_ENDPOINTS.transitReachabilitySurface,
        request,
        { signal, timeoutMs: 35_000 },
      );
    },
    enabled: enabled && request !== null,
    staleTime: 300_000,
    gcTime: 600_000,
  });
  return wrapMobilityEnvelope(query);
}
