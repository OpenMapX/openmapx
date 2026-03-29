import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../api/client";
import { API_ENDPOINTS } from "../api/endpoints";

interface CapabilitiesResponse {
  services: Record<string, boolean>;
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
      return query.data.services[serviceId] ?? true;
    },
  };
}
