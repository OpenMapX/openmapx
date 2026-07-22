"use client";

import type { StreetLevelCapabilities } from "@openmapx/core";
import { useQuery } from "@tanstack/react-query";
import { useEnv } from "@/lib/EnvProvider";

/** Stable identity so consumers' effect dependencies don't fire every render. */
const NO_PROVIDERS: StreetLevelCapabilities[] = [];

/**
 * The enabled street-level-imagery providers in priority order. Capabilities are static
 * per deployment, so this is cached aggressively.
 */
export function useStreetLevelProviders(): {
  providers: StreetLevelCapabilities[];
  isLoading: boolean;
} {
  const { apiUrl } = useEnv();

  const { data, isLoading } = useQuery({
    queryKey: ["street-level-imagery-providers", apiUrl],
    queryFn: async (): Promise<StreetLevelCapabilities[]> => {
      const response = await fetch(`${apiUrl}/api/street-level-imagery/providers`);
      if (!response.ok) return [];
      return (await response.json()) as StreetLevelCapabilities[];
    },
    staleTime: Number.POSITIVE_INFINITY,
  });

  return { providers: data ?? NO_PROVIDERS, isLoading };
}
