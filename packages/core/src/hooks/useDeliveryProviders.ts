import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../api/client";
import { API_ENDPOINTS } from "../api/endpoints";
import type { DeliveryProviderInfo } from "../types/delivery";

interface DeliveryProvidersResponse {
  providers: DeliveryProviderInfo[];
}

/**
 * Fetch the food-delivery platforms that serve the given country. Driven by the
 * backend `food-delivery` integration, so adding a platform there makes it
 * appear automatically. Pass the place's country code to region-filter the list.
 */
export function useDeliveryProviders(countryCode?: string, enabled = true) {
  // Normalise case so 'DE' and 'de' share one cache entry / request (the server
  // lowercases the country anyway).
  const cc = countryCode?.toLowerCase();
  return useQuery<DeliveryProvidersResponse>({
    queryKey: ["delivery-providers", cc ?? ""],
    queryFn: () =>
      apiClient.get<DeliveryProvidersResponse>(
        API_ENDPOINTS.foodDeliveryProviders,
        cc ? { country: cc } : undefined,
      ),
    enabled,
    staleTime: 60 * 60 * 1000,
  });
}
