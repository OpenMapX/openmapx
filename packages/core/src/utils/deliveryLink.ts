import { apiUrl } from "../api/client";
import { API_ENDPOINTS } from "../api/endpoints";
import type { DeliverySearchParams } from "../types/delivery";

/**
 * Build the absolute URL of the backend redirect endpoint that forwards to the
 * chosen platform's pre-filled search. Returning the API URL (rather than the
 * final platform URL) keeps every provider's URL-building + affiliate logic on
 * the server — the UI just `window.open`s this synchronously on click.
 */
export function buildDeliveryOpenUrl(provider: string, p: DeliverySearchParams): string {
  const params: Record<string, string> = { name: p.name };
  if (p.city) params.city = p.city;
  if (p.countryCode) params.country = p.countryCode;
  if (typeof p.lat === "number") params.lat = String(p.lat);
  if (typeof p.lng === "number") params.lng = String(p.lng);
  if (p.postcode) params.postcode = p.postcode;
  if (p.address) params.address = p.address;
  return apiUrl(`${API_ENDPOINTS.foodDelivery}/${encodeURIComponent(provider)}/open`, params);
}
