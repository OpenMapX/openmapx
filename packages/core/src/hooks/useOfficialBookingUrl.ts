import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../api/client";
import { API_ENDPOINTS } from "../api/endpoints";

/**
 * Resolve the hotel's own dated booking deep link by crawling its website
 * (schema.org ReserveAction or a known booking-engine link). Returns null when
 * none is found (the UI then opens the plain homepage). Gated on a website.
 */
export function useOfficialBookingUrl(
  p: {
    name: string;
    website?: string | null;
    checkIn?: string;
    checkOut?: string;
    adults?: number;
    rooms?: number;
  },
  enabled = true,
) {
  return useQuery<string | null>({
    queryKey: ["official-booking", p.website ?? "", p.checkIn, p.checkOut, p.adults, p.rooms],
    queryFn: async () => {
      if (!p.website) return null;
      const params: Record<string, string> = { name: p.name, website: p.website };
      if (p.checkIn) params.checkIn = p.checkIn;
      if (p.checkOut) params.checkOut = p.checkOut;
      if (typeof p.adults === "number") params.adults = String(p.adults);
      if (typeof p.rooms === "number") params.rooms = String(p.rooms);
      const res = await apiClient.getOptional<{ url: string }>(API_ENDPOINTS.hotelOfficial, params);
      return res?.url ?? null;
    },
    enabled: enabled && Boolean(p.website),
    staleTime: 24 * 60 * 60 * 1000,
  });
}
