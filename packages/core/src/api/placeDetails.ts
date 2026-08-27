import type { LngLat } from "../types/geometry";

const COORDINATE_DECIMALS = 6;

export interface PlaceDetailsRequestInput {
  id: string;
  coordinates?: LngLat;
  name?: string;
  lang?: string;
  hasAddress?: boolean;
}

export interface PlaceDetailsIdentity {
  id: string;
  lng: number | null;
  lat: number | null;
  name: string | null;
  lang: string | null;
  hasAddress: boolean;
}

export interface PlaceDetailsRequest {
  identity: PlaceDetailsIdentity;
  params: Record<string, string>;
}

function normalizedCoordinate(value: number, min: number, max: number): number | null {
  if (!Number.isFinite(value) || value < min || value > max) return null;
  const normalized = Number(value.toFixed(COORDINATE_DECIMALS));
  return Object.is(normalized, -0) ? 0 : normalized;
}

/**
 * Builds the one canonical representation used by the browser request, React
 * Query identity, and API cache. Coordinates are rounded to roughly 11 cm at
 * the equator, fine enough for place resolution while removing serialization
 * noise; the rounded values are also sent upstream, so cache identity can never
 * describe different inputs from the actual request.
 */
export function buildPlaceDetailsRequest(input: PlaceDetailsRequestInput): PlaceDetailsRequest {
  const lng = input.coordinates ? normalizedCoordinate(input.coordinates[0], -180, 180) : null;
  const lat = input.coordinates ? normalizedCoordinate(input.coordinates[1], -90, 90) : null;
  const coordinatesValid = lng !== null && lat !== null;
  const name = input.name?.trim() || null;
  const requestedLang = input.lang?.trim() || null;
  const hasAddress = input.hasAddress ?? false;
  const identity: PlaceDetailsIdentity = {
    id: input.id,
    lng: coordinatesValid ? lng : null,
    lat: coordinatesValid ? lat : null,
    name,
    lang: requestedLang,
    hasAddress,
  };
  const params: Record<string, string> = {};
  if (identity.lat !== null && identity.lng !== null) {
    params.lat = String(identity.lat);
    params.lng = String(identity.lng);
  }
  if (name) params.name = name;
  if (requestedLang) params.lang = requestedLang;
  if (hasAddress) params.hasAddress = "1";
  return { identity, params };
}
