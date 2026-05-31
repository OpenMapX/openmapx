import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../api/client";
import { API_ENDPOINTS } from "../api/endpoints";
import type { HotelProviderInfo } from "../types/hotel";

interface HotelProvidersResponse {
  providers: HotelProviderInfo[];
}

/**
 * Region-filtered list of hotel OTAs for the compare list. Normalises the
 * country code so 'DE' and 'de' share one cache entry. Mirrors useDeliveryProviders.
 */
export function useHotelProviders(countryCode?: string, enabled = true) {
  const cc = countryCode?.toLowerCase();
  return useQuery<HotelProvidersResponse>({
    queryKey: ["hotel-providers", cc ?? ""],
    queryFn: () =>
      apiClient.get<HotelProvidersResponse>(
        API_ENDPOINTS.hotelProviders,
        cc ? { country: cc } : undefined,
      ),
    enabled,
    staleTime: 60 * 60 * 1000, // 1 hour
  });
}
