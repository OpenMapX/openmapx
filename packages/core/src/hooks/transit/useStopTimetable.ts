import type { MobilityEnvelope } from "@openmapx/mobility-core/result";
import type { Departure } from "@openmapx/mobility-core/transit";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../../api/client";
import { API_ENDPOINTS } from "../../api/endpoints";
import { type MobilityEnvelopeQueryResult, wrapMobilityEnvelope } from "./useMobilityEnvelope";

/** Returns all departures for a stop on a given date (YYYY-MM-DD). Defaults to today. */
export function useStopTimetable(
  stopId: string | null,
  date?: string,
): MobilityEnvelopeQueryResult<Departure[]> {
  const query = useQuery({
    queryKey: ["stop-timetable", stopId, date],
    queryFn: () => {
      const url = API_ENDPOINTS.transitStopTimetable.replace(
        ":id",
        encodeURIComponent(stopId as string),
      );
      const params: Record<string, string> = {};
      if (date) params.date = date;
      return apiClient.get<MobilityEnvelope<Departure[]>>(url, params);
    },
    enabled: stopId !== null,
    staleTime: 5 * 60_000,
  });
  return wrapMobilityEnvelope(query);
}
