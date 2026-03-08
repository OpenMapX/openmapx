import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../api/client";
import { API_ENDPOINTS } from "../api/endpoints";
import type { FuelStationDetail } from "../types/fuel";

export function useFuelStationDetail(placeId: string | null) {
  const isTankerkoenig = placeId?.startsWith("tankerkoenig/") ?? false;
  return useQuery({
    queryKey: ["fuel-station-detail", placeId],
    queryFn: () =>
      apiClient.get<FuelStationDetail>(API_ENDPOINTS.fuelPricesDetail, { id: placeId as string }),
    enabled: isTankerkoenig,
    staleTime: 60_000,
  });
}
