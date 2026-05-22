import type { MobilityEnvelope } from "@openmapx/mobility-core/result";
import type { TransitStop } from "@openmapx/mobility-core/transit";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../../api/client";
import { API_ENDPOINTS } from "../../api/endpoints";
import { usePrefixPlaceholder } from "../usePrefixPlaceholder";
import { type MobilityEnvelopeQueryResult, wrapMobilityEnvelope } from "./useMobilityEnvelope";

export function useStopSearch(query: string): MobilityEnvelopeQueryResult<TransitStop[]> {
  const placeholderData = usePrefixPlaceholder<MobilityEnvelope<TransitStop[]>>(
    "stop-search",
    query,
  );
  const result = useQuery({
    queryKey: ["stop-search", query],
    queryFn: () =>
      apiClient.get<MobilityEnvelope<TransitStop[]>>(API_ENDPOINTS.transitStopSearch, {
        q: query,
        limit: "3",
      }),
    enabled: query.trim().length >= 2,
    staleTime: 5 * 60_000,
    placeholderData,
  });
  return wrapMobilityEnvelope(result);
}
