import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../../api/client";
import { API_ENDPOINTS } from "../../api/endpoints";
import type { ProviderAttribution } from "../../constants/transit";

/**
 * Fetches the merged provider attribution map from `/api/integrations/transit/providers`.
 * Covers both static hand-crafted providers (DB, TfL, …) and dynamic registry
 * providers (rsag, vbn, vsn, …).
 *
 * Stale after 24 h — provider names almost never change.
 *
 * @deprecated Per-component attribution rendering was removed in plan §F5;
 * use the `attributions` field exposed on the new envelope-aware hooks (e.g.
 * `useDepartures().attributions`) plus `<AttributionStrip>` instead. This hook
 * is retained for legacy `/api/attribution`-style lookups and may be removed
 * once no consumers remain.
 */
export function useProviders(): { data: Record<string, ProviderAttribution> } {
  const { data = {} } = useQuery({
    queryKey: ["transit-providers"],
    queryFn: () =>
      apiClient.get<Record<string, ProviderAttribution>>(API_ENDPOINTS.transitProviders),
    staleTime: 24 * 60 * 60 * 1000,
  });
  return { data };
}
