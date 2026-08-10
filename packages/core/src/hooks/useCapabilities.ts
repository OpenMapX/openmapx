import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../api/client";
import { API_ENDPOINTS } from "../api/endpoints";

export interface ServiceCapability {
  configured: boolean;
  enabled: boolean;
  healthy: boolean;
  available: boolean;
  domains: string[];
}

interface CapabilitiesResponse {
  services: Record<string, ServiceCapability>;
  /** Bounded public feature bits. Absent on an older API. */
  features?: { osmContributions?: boolean };
}

export function useCapabilities() {
  const query = useQuery({
    queryKey: ["capabilities"],
    queryFn: () => apiClient.get<CapabilitiesResponse>(API_ENDPOINTS.capabilities),
    staleTime: 60_000,
  });

  return {
    ...query,
    services: query.data?.services ?? {},
    /**
     * Fails closed. Unlike `isAvailable` — which is optimistic so integration
     * UI keeps working while capabilities load — an unreleased feature must
     * stay hidden until the server has explicitly said it is on.
     */
    osmContributionsEnabled: query.data?.features?.osmContributions === true,
    isAvailable: (serviceId: string | undefined) => {
      if (!serviceId) return true;
      if (!query.data) return true;
      const service = query.data.services[serviceId];
      if (!service) return false;
      return service.available;
    },
    getCapability: (serviceId: string): ServiceCapability | undefined => {
      return query.data?.services[serviceId];
    },
  };
}
