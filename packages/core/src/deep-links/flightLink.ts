import { apiUrl } from "../api/client";
import { API_ENDPOINTS } from "../api/endpoints";
import type { FlightSearchParams } from "../types/flights";

/**
 * Build the absolute URL of the backend redirect endpoint that forwards to the
 * chosen provider's pre-filled flight search. Returning the API URL (rather
 * than the final provider URL) keeps every provider's URL-building logic on the
 * server — the UI just `window.open`s this synchronously on click.
 */
export function buildFlightOpenUrl(provider: string, p: FlightSearchParams): string {
  const params: Record<string, string> = {
    from: p.from,
    to: p.to,
    depart: p.departDate,
    adults: String(p.adults),
    children: String(p.children),
    infants: String(p.infants),
    cabin: p.cabin,
  };
  if (p.returnDate) params.return = p.returnDate;
  if (p.directOnly) params.direct = "1";
  return apiUrl(`${API_ENDPOINTS.flights}/${encodeURIComponent(provider)}/open`, params);
}
