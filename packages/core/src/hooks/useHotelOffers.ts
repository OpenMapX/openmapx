import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../api/client";
import { API_ENDPOINTS } from "../api/endpoints";
import type { HotelOffersResponse, HotelSearchParams } from "../types/hotel";

/**
 * Live lowest-rate lookup. Returns null when live prices are off / no match
 * (the backend replies 204) — the UI then shows only the deep-link list.
 * Gated on coordinates + dates. Currency + guest nationality (user-chosen) are
 * part of the key so changing them refetches.
 */
export function useHotelOffers(p: HotelSearchParams, enabled = true) {
  const hasCoords = typeof p.lat === "number" && typeof p.lng === "number";
  const ready = Boolean(p.checkIn && p.checkOut && hasCoords && p.name);
  return useQuery<HotelOffersResponse | null>({
    queryKey: [
      "hotel-offers",
      p.name,
      p.lat,
      p.lng,
      p.checkIn,
      p.checkOut,
      p.adults,
      p.rooms,
      p.currency,
      p.guestNationality,
    ],
    queryFn: () => {
      const params: Record<string, string> = { name: p.name };
      if (typeof p.lat === "number") params.lat = String(p.lat);
      if (typeof p.lng === "number") params.lng = String(p.lng);
      if (p.countryCode) params.country = p.countryCode;
      if (p.checkIn) params.checkIn = p.checkIn;
      if (p.checkOut) params.checkOut = p.checkOut;
      if (typeof p.adults === "number") params.adults = String(p.adults);
      if (typeof p.rooms === "number") params.rooms = String(p.rooms);
      if (p.currency) params.currency = p.currency;
      if (p.guestNationality) params.nationality = p.guestNationality;
      return apiClient.getOptional<HotelOffersResponse>(API_ENDPOINTS.hotelOffers, params);
    },
    enabled: enabled && ready,
    staleTime: 15 * 60 * 1000, // 15 minutes — prices are short-lived
  });
}
