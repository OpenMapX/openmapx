import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../api/client";
import { API_ENDPOINTS } from "../api/endpoints";
import type { FlightProviderInfo } from "../types/flights";

interface FlightProvidersResponse {
  providers: FlightProviderInfo[];
  defaultProvider: string;
}

/**
 * Fetch the list of available flight-search providers and their capabilities.
 * Driven by the backend `flights` integration, so adding a provider there makes
 * it appear in the UI selector automatically.
 */
export function useFlightProviders() {
  return useQuery<FlightProvidersResponse>({
    queryKey: ["flight-providers"],
    queryFn: () => apiClient.get<FlightProvidersResponse>(API_ENDPOINTS.flightProviders),
    staleTime: 60 * 60 * 1000,
  });
}
