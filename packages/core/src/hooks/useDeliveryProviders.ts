import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../api/client";
import { API_ENDPOINTS } from "../api/endpoints";
import type { DeliveryProviderInfo, DeliverySearchParams } from "../types/delivery";

interface DeliveryProvidersResponse {
  providers: DeliveryProviderInfo[];
  degraded?: boolean;
}

// Keep this aligned with the backend resolver cache namespace. Including it in
// the request URL prevents a browser-cached negative result from surviving a
// resolver deployment (for example, the Frittenwerk single-brand match fix).
const DELIVERY_RESOLUTION_VERSION = "3";

export function useDeliveryProviderCatalog(countryCode?: string, enabled = true) {
  const cc = countryCode?.toLowerCase();
  return useQuery<DeliveryProvidersResponse>({
    queryKey: ["delivery-provider-catalog", cc ?? ""],
    queryFn: () =>
      apiClient.get<DeliveryProvidersResponse>(API_ENDPOINTS.foodDeliveryProviders, {
        country: cc as string,
      }),
    enabled: enabled && Boolean(cc),
    staleTime: 60 * 60 * 1000,
  });
}

/**
 * Fetch the food-delivery platforms that serve the given country. Driven by the
 * backend `food-delivery` integration, so adding a platform there makes it
 * appear automatically. Pass the place's country code to region-filter the list.
 */
export function useDeliveryProviders(params: DeliverySearchParams, enabled = true) {
  const cc = params.countryCode?.toLowerCase();
  return useQuery<DeliveryProvidersResponse>({
    queryKey: [
      "delivery-providers",
      DELIVERY_RESOLUTION_VERSION,
      params.name,
      cc ?? "",
      params.city ?? "",
      params.lat ?? "",
      params.lng ?? "",
      params.postcode ?? "",
      params.address ?? "",
    ],
    queryFn: () =>
      apiClient.get<DeliveryProvidersResponse>(API_ENDPOINTS.foodDeliveryResolve, {
        v: DELIVERY_RESOLUTION_VERSION,
        name: params.name,
        ...(cc ? { country: cc } : {}),
        ...(params.city ? { city: params.city } : {}),
        ...(typeof params.lat === "number" ? { lat: String(params.lat) } : {}),
        ...(typeof params.lng === "number" ? { lng: String(params.lng) } : {}),
        ...(params.postcode ? { postcode: params.postcode } : {}),
        ...(params.address ? { address: params.address } : {}),
      }),
    enabled: enabled && Boolean(cc),
    staleTime: (query) => (query.state.data?.degraded ? 0 : 60 * 60 * 1000),
  });
}
