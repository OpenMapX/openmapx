import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../api/client";
import { API_ENDPOINTS } from "../api/endpoints";
import type { HotelProviderInfo } from "../types/hotel";

interface HotelProvidersResponse {
  providers: HotelProviderInfo[];
}

/** Hotel-identity params for /resolve. Dates are intentionally NOT included —
 *  the resolvable provider set is per-hotel, not per-stay, so the result caches
 *  across date changes. */
export interface ResolveHotelParams {
  name: string;
  lat?: number;
  lng?: number;
  countryCode?: string;
  /** OSM `wikidata=Q…` tag, when the place carries one. */
  wikidata?: string;
}

/**
 * Which OTAs can deep-link THIS specific hotel: Booking.com (universal search)
 * plus any id-only OTA whose exact hotel id resolved server-side (Wikidata /
 * typeahead). The hotel-aware provider list for the compare surface. Keyed on
 * the hotel identity (not dates) so it stays cached as the user edits the stay.
 */
export function useResolvedHotelProviders(params: ResolveHotelParams, enabled = true) {
  const { name, lat, lng, countryCode, wikidata } = params;
  const cc = countryCode?.toLowerCase();
  return useQuery<HotelProvidersResponse>({
    queryKey: ["hotel-resolve", name, lat ?? "", lng ?? "", cc ?? "", wikidata ?? ""],
    queryFn: () => {
      const q: Record<string, string> = { name };
      if (typeof lat === "number") q.lat = String(lat);
      if (typeof lng === "number") q.lng = String(lng);
      if (cc) q.country = cc;
      if (wikidata) q.wikidata = wikidata;
      return apiClient.get<HotelProvidersResponse>(API_ENDPOINTS.hotelResolve, q);
    },
    enabled: enabled && Boolean(name),
    staleTime: 60 * 60 * 1000, // 1 hour — resolvable set is stable per hotel
  });
}
