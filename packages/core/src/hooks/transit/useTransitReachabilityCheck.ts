import type { MobilityEnvelope } from "@openmapx/mobility-core/result";
import type {
  TransitReachabilityCheckRequest,
  TransitReachabilityCheckResult,
} from "@openmapx/mobility-core/transit-reachability";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../../api/client";
import { API_ENDPOINTS } from "../../api/endpoints";
import { type MobilityEnvelopeQueryResult, wrapMobilityEnvelope } from "./useMobilityEnvelope";

export function transitReachabilityDestinationKey(request: TransitReachabilityCheckRequest | null) {
  return (
    request?.destinations.map(({ id, lng, lat }) => [id, lng.toFixed(5), lat.toFixed(5)]) ?? []
  );
}

export function useTransitReachabilityCheck(
  request: TransitReachabilityCheckRequest | null,
  enabled = true,
): MobilityEnvelopeQueryResult<TransitReachabilityCheckResult> {
  const destinationKey = transitReachabilityDestinationKey(request);
  const query = useQuery({
    queryKey: [
      "transit-reachability-check",
      request ? { ...request, destinations: destinationKey } : null,
    ],
    queryFn: ({ signal }) => {
      if (!request) throw new Error("Exact transit reachability request required");
      return apiClient.post<MobilityEnvelope<TransitReachabilityCheckResult>>(
        API_ENDPOINTS.transitReachabilityCheck,
        request,
        { signal, timeoutMs: 35_000 },
      );
    },
    enabled: enabled && request !== null && request.destinations.length > 0,
    staleTime: 300_000,
    gcTime: 600_000,
    retry: false,
  });
  return wrapMobilityEnvelope(query);
}
