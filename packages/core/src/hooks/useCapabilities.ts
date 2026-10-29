import { useQuery } from "@tanstack/react-query";
import { getApiCapabilities } from "../api/generated/runtime-metadata.generated";

export function useCapabilities() {
  const query = useQuery({
    queryKey: ["capabilities"],
    queryFn: async ({ signal }) => (await getApiCapabilities({ signal })).data,
    staleTime: 60_000,
  });

  return {
    ...query,
    services: query.data?.services ?? {},
    // Unreleased UI remains hidden until validated metadata explicitly enables it.
    osmContributionsEnabled: query.data?.features.osmContributions === true,
    isAvailable: (serviceId: string | undefined) => {
      if (!serviceId || !query.data) return true;
      return query.data.services[serviceId]?.available ?? false;
    },
  };
}
