import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../api/client";
import { API_ENDPOINTS } from "../api/endpoints";

export interface ServiceCapability {
  configured: boolean;
  enabled: boolean;
  domains: string[];
}

interface CapabilitiesResponse {
  services: Record<string, ServiceCapability>;
}

export function useCapabilities() {
  const query = useQuery({
    queryKey: ["capabilities"],
    queryFn: () => apiClient.get<CapabilitiesResponse>(API_ENDPOINTS.capabilities),
    staleTime: 3_600_000,
  });

  return {
    ...query,
    services: query.data?.services ?? {},
    isAvailable: (serviceId: string | undefined) => {
      if (!serviceId) return true;
      if (!query.data) return true;
      const service = query.data.services[serviceId];
      if (!service) return true;
      return service.configured && service.enabled;
    },
    getCapability: (serviceId: string): ServiceCapability | undefined => {
      return query.data?.services[serviceId];
    },
  };
}
