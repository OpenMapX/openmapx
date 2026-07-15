import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../../api/client";
import { API_ENDPOINTS } from "../../api/endpoints";

export interface TransitPlanningCapabilityProvider {
  id: string;
  features?: {
    maxTransfers: boolean;
    transferBuffer: boolean;
    wheelchairRequired: boolean;
    bikeTransport: boolean;
    elevation: boolean;
    rentalFilters: boolean;
    detailedTransfers: boolean;
    paging: boolean;
    refresh: boolean;
  };
  metadata?: {
    source: string;
    instance: string;
    datasetEpoch: string;
    rentalFormFactors: string[];
  };
}

export function useTransitPlanningCapabilities() {
  return useQuery({
    queryKey: ["transit-planning-capabilities"],
    queryFn: () =>
      apiClient.get<{ providers: TransitPlanningCapabilityProvider[] }>(
        API_ENDPOINTS.transitPlanningCapabilities,
      ),
    staleTime: 60_000,
  });
}
