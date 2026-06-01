import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../api/client";
import { API_ENDPOINTS } from "../api/endpoints";
import type { HotelConfig } from "../types/hotel";

/**
 * Tier 2 config: whether the operator enabled live prices (LiteAPI key set) and
 * the default currency used to preset the rate controls. The `/config` route
 * always returns 200 (with `liveEnabled: false` when off), so the UI can decide
 * whether to render the rate controls + fire the offers query. Long staleTime —
 * config rarely changes.
 */
export function useHotelConfig(enabled = true) {
  return useQuery<HotelConfig>({
    queryKey: ["hotel-config"],
    queryFn: () => apiClient.get<HotelConfig>(API_ENDPOINTS.hotelConfig),
    enabled,
    staleTime: 60 * 60 * 1000,
  });
}
