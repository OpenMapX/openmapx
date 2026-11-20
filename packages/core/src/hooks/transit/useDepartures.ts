import type { MobilityEnvelope } from "@openmapx/mobility-core/result";
import type { Departure } from "@openmapx/mobility-core/transit";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../../api/client";
import { type MobilityEnvelopeQueryResult, wrapMobilityEnvelope } from "./useMobilityEnvelope";

export function useDepartures(
  stopId: string | null,
  minutes = 60,
): MobilityEnvelopeQueryResult<Departure[]> {
  const query = useQuery({
    queryKey: ["departures", stopId, minutes],
    queryFn: ({ signal }) =>
      apiClient.get<MobilityEnvelope<Departure[]>>(
        `/api/integrations/transit/stops/${encodeURIComponent(stopId as string)}/departures`,
        {
          minutes: String(minutes),
        },
        { signal },
      ),
    enabled: stopId !== null,
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
  return wrapMobilityEnvelope(query);
}
