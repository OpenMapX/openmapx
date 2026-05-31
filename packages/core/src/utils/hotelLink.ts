import { apiUrl } from "../api/client";
import { API_ENDPOINTS } from "../api/endpoints";
import type { HotelSearchParams } from "../types/hotel";

/**
 * Build the absolute URL of the backend redirect endpoint that forwards to the
 * chosen OTA's pre-filled search (hotel name + dates + occupancy). URL-building
 * logic stays on the server — mirrors buildDeliveryOpenUrl.
 */
export function buildHotelOpenUrl(provider: string, p: HotelSearchParams): string {
  const params: Record<string, string> = { name: p.name };
  if (p.city) params.city = p.city;
  if (p.countryCode) params.country = p.countryCode;
  if (typeof p.lat === "number") params.lat = String(p.lat);
  if (typeof p.lng === "number") params.lng = String(p.lng);
  if (p.address) params.address = p.address;
  if (p.checkIn) params.checkIn = p.checkIn;
  if (p.checkOut) params.checkOut = p.checkOut;
  if (typeof p.adults === "number") params.adults = String(p.adults);
  if (typeof p.rooms === "number") params.rooms = String(p.rooms);
  return apiUrl(`${API_ENDPOINTS.hotels}/${encodeURIComponent(provider)}/open`, params);
}
