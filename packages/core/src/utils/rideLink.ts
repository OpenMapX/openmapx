import { apiUrl } from "../api/client";
import { API_ENDPOINTS } from "../api/endpoints";
import type { RideQuoteRequest } from "../types/ride";

/**
 * Flatten a ride request into the query-parameter names the backend's
 * `parseRideQuery` expects. Absent fields are omitted rather than sent empty,
 * so a link never carries a coordinate the user did not supply.
 */
function toParams(request: RideQuoteRequest): Record<string, string> {
  const params: Record<string, string> = {
    pickupLat: String(request.pickup[1]),
    pickupLng: String(request.pickup[0]),
  };
  if (request.dropoff) {
    params.dropoffLat = String(request.dropoff[1]);
    params.dropoffLng = String(request.dropoff[0]);
  }
  if (request.pickupAddress) params.pickupAddress = request.pickupAddress;
  if (request.dropoffAddress) params.dropoffAddress = request.dropoffAddress;
  if (request.pickupAt) params.pickupAt = request.pickupAt;
  if (request.passengers !== undefined) params.passengers = String(request.passengers);
  if (request.productId) params.productId = request.productId;
  if (request.lang) params.lang = request.lang;
  if (request.route) {
    params.routeDistanceMeters = String(request.route.distanceMeters);
    params.routeDurationSeconds = String(request.route.durationSeconds);
  }
  return params;
}

/**
 * Build the absolute URL of the backend redirect that forwards to the chosen
 * provider's app or booking page. Returning the API URL (rather than the final
 * provider URL) keeps every provider's URL-building logic — and any affiliate
 * id — on the server; the UI just `window.open`s this synchronously on click.
 */
export function buildRideOpenUrl(provider: string, request: RideQuoteRequest): string {
  return apiUrl(
    `${API_ENDPOINTS.rideHailing}/${encodeURIComponent(provider)}/open`,
    toParams(request),
  );
}

/** Body for `POST /quotes`. */
export function rideQuoteBody(
  request: RideQuoteRequest,
  providerIds: string[],
): Record<string, unknown> {
  return { ...toParams(request), providerIds };
}
