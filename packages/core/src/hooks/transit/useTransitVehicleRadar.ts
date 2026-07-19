import type { MobilityEnvelope } from "@openmapx/mobility-core/result";
import type { VehiclePosition } from "@openmapx/mobility-core/transit";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../../api/client";
import { API_ENDPOINTS } from "../../api/endpoints";
import type { BBox } from "../../types/geometry";
import { type MobilityEnvelopeQueryResult, wrapMobilityEnvelope } from "./useMobilityEnvelope";

/**
 * Live transit vehicle positions within a bounding box (MOTIS `map/trips`,
 * interpolated to now server-side). Polls every 10s. Pass null to disable —
 * e.g. when zoomed out too far to keep the count sane.
 */
export function useTransitVehicleRadar(
  bbox: BBox | null,
): MobilityEnvelopeQueryResult<VehiclePosition[]> {
  const query = useQuery({
    queryKey: ["transit-vehicle-radar", bbox],
    queryFn: () => {
      const [west, south, east, north] = bbox as BBox;
      return apiClient.get<MobilityEnvelope<VehiclePosition[]>>(API_ENDPOINTS.transitVehicles, {
        sw_lat: String(south),
        sw_lng: String(west),
        ne_lat: String(north),
        ne_lng: String(east),
      });
    },
    enabled: bbox !== null,
    staleTime: 10_000,
    refetchInterval: 10_000,
  });
  return wrapMobilityEnvelope(query);
}
