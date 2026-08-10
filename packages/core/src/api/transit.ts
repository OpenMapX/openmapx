import type { MobilityEnvelope } from "@openmapx/mobility-core/result";
import type { TripItinerary, TripPlan, VehicleJourney } from "@openmapx/mobility-core/transit";
import type { LngLat } from "../types/geometry";
import { type ApiClient, type ApiRequestOptions, apiClient } from "./client";
import { API_ENDPOINTS } from "./endpoints";

/**
 * Hook-free transit API calls.
 *
 * The React hooks in `hooks/transit` are thin wrappers over these, so the
 * headless mobile coordinator can plan, refresh and fetch journeys with its own
 * `credentials: "omit"` client without a React runtime — and without the two
 * paths drifting into different query parameters.
 */

export interface TransitPlanParams {
  origin: LngLat;
  destination: LngLat;
  /** ISO 8601 departure time, or arrival time when `arriveBy` is set. */
  time: string;
  arriveBy?: boolean;
  numItineraries?: number;
  lang?: string;
  modes?: string[];
  wheelchair?: boolean;
  wheelchairRequired?: boolean;
  maxTransfers?: number;
  transferBuffer?: "standard" | "relaxed" | "extra";
  requireBikeTransport?: boolean;
  bikeHillPreference?: "default" | "avoid" | "strongly-avoid";
  rentalFormFactors?: string[];
  preTransitModes?: string[];
  postTransitModes?: string[];
  directModes?: string[];
  deutschlandticketOnly?: boolean;
  /** Signed OpenMapX paging token; never an upstream cursor. */
  pageToken?: string;
  capabilityEpoch?: string;
  rentalSource?: string;
  rentalInstance?: string;
}

/** Order-independent list parameter, so the same set always produces one key. */
function listParam(values: string[] | undefined): string | undefined {
  if (!values || values.length === 0) return undefined;
  return [...new Set(values)].sort().join(",");
}

/**
 * The single definition of a transit plan request's query string. Shared so the
 * browser and the background replan cannot ask for subtly different journeys.
 */
export function buildTransitPlanParams(params: TransitPlanParams): Record<string, string> {
  const query: Record<string, string> = {
    from_lat: String(params.origin[1]),
    from_lng: String(params.origin[0]),
    to_lat: String(params.destination[1]),
    to_lng: String(params.destination[0]),
    time: params.time,
  };
  if (params.arriveBy) query.arrive_by = "true";
  if (params.numItineraries && params.numItineraries !== 3) {
    query.num_itineraries = String(params.numItineraries);
  }
  if (params.lang) query.lang = params.lang;

  const modes = listParam(params.modes);
  if (modes) query.modes = modes;
  if (params.wheelchair || params.wheelchairRequired) query.wheelchair = "true";
  if (params.maxTransfers !== undefined) query.max_transfers = String(params.maxTransfers);
  if (params.transferBuffer && params.transferBuffer !== "standard") {
    query.transfer_buffer = params.transferBuffer;
  }
  if (params.requireBikeTransport) query.require_bike_transport = "true";
  if (params.bikeHillPreference && params.bikeHillPreference !== "default") {
    query.bike_hill_preference = params.bikeHillPreference;
  }
  const rentalFormFactors = listParam(params.rentalFormFactors);
  if (rentalFormFactors) query.rental_form_factors = rentalFormFactors;
  const pre = listParam(params.preTransitModes);
  if (pre) query.pre_modes = pre;
  const post = listParam(params.postTransitModes);
  if (post) query.post_modes = post;
  const direct = listParam(params.directModes);
  if (direct) query.direct_modes = direct;
  if (params.deutschlandticketOnly) query.deutschlandticket = "true";
  if (params.pageToken) query.page_token = params.pageToken;
  if (params.capabilityEpoch) query.capability_epoch = params.capabilityEpoch;
  if (params.rentalSource) query.rental_source = params.rentalSource;
  if (params.rentalInstance) query.rental_instance = params.rentalInstance;
  return query;
}

export function fetchTransitPlan(
  params: TransitPlanParams,
  client: ApiClient = apiClient,
  options: ApiRequestOptions = {},
): Promise<MobilityEnvelope<TripPlan>> {
  return client.get<MobilityEnvelope<TripPlan>>(
    API_ENDPOINTS.transitPlan,
    buildTransitPlanParams(params),
    options,
  );
}

export interface TransitRefreshResult {
  itinerary: TripItinerary;
  fallbackOccurred: boolean;
}

/**
 * Rotates the live-refresh token.
 *
 * The token is one-time: the server spends it and returns a replacement. A
 * caller that retries the same token after an ambiguous failure may find it
 * already consumed, which is why the mobile coordinator marks such a chain
 * broken and replans rather than retrying blindly.
 */
export function refreshTransitItinerary(
  token: string,
  client: ApiClient = apiClient,
  options: ApiRequestOptions = {},
): Promise<MobilityEnvelope<TransitRefreshResult>> {
  return client.post<MobilityEnvelope<TransitRefreshResult>>(
    API_ENDPOINTS.transitPlanRefresh,
    { token },
    options,
  );
}

export interface VehicleJourneyParams {
  tripId: string;
  /** Alternative ids the server may try when the trip id alone does not resolve. */
  fallbackIds?: string[];
}

/**
 * Fetches the stop sequence of one vehicle journey, which is what the transit
 * capture slices down to the ridden segment.
 */
export function fetchVehicleJourney(
  params: VehicleJourneyParams,
  client: ApiClient = apiClient,
  options: ApiRequestOptions = {},
): Promise<MobilityEnvelope<VehicleJourney>> {
  const url = API_ENDPOINTS.transitVehicleJourney.replace(":id", encodeURIComponent(params.tripId));
  // Left unencoded on purpose: the client builds the query with
  // `URLSearchParams`, which encodes once. Pre-encoding would double it.
  const query = params.fallbackIds?.length
    ? { fallback_ids: params.fallbackIds.join(",") }
    : undefined;
  return client.get<MobilityEnvelope<VehicleJourney>>(url, query, options);
}
