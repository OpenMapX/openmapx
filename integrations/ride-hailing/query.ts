import type { RideQuoteRequest } from "@openmapx/integration-framework";

const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
const MAX_PASSENGERS = 8;

export type ParseResult = { ok: true; request: RideQuoteRequest } | { ok: false; error: string };

function parseCoord(
  lat: string | undefined,
  lng: string | undefined,
): [number, number] | null | "invalid" {
  if (lat === undefined && lng === undefined) return null;
  const latN = Number.parseFloat(lat ?? "");
  const lngN = Number.parseFloat(lng ?? "");
  if (!Number.isFinite(latN) || !Number.isFinite(lngN)) return "invalid";
  if (latN < -90 || latN > 90 || lngN < -180 || lngN > 180) return "invalid";
  return [lngN, latN];
}

function parsePositiveInt(raw: string | undefined): number | undefined {
  const n = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/**
 * Validate and normalise the query string shared by every ride route. Both the
 * redirect endpoints and the quote endpoint go through this, so a malformed
 * coordinate can never reach a provider.
 */
export function parseRideQuery(q: Record<string, string>): ParseResult {
  const pickup = parseCoord(q.pickupLat, q.pickupLng);
  if (pickup === null) return { ok: false, error: "'pickupLat' and 'pickupLng' are required" };
  if (pickup === "invalid") return { ok: false, error: "'pickupLat'/'pickupLng' are out of range" };

  const dropoff = parseCoord(q.dropoffLat, q.dropoffLng);
  if (dropoff === "invalid") {
    return { ok: false, error: "'dropoffLat'/'dropoffLng' are out of range" };
  }

  const pickupAt = (q.pickupAt ?? "").trim();
  if (pickupAt && !DATETIME_RE.test(pickupAt)) {
    return { ok: false, error: "'pickupAt' must be a YYYY-MM-DDTHH:mm wall-clock time" };
  }

  const passengersRaw = parsePositiveInt(q.passengers);
  const distanceMeters = parsePositiveInt(q.routeDistanceMeters);
  const durationSeconds = parsePositiveInt(q.routeDurationSeconds);

  return {
    ok: true,
    request: {
      pickup,
      dropoff: dropoff ?? undefined,
      pickupAddress: (q.pickupAddress ?? "").trim() || undefined,
      dropoffAddress: (q.dropoffAddress ?? "").trim() || undefined,
      pickupAt: pickupAt || undefined,
      passengers:
        passengersRaw === undefined
          ? undefined
          : Math.min(MAX_PASSENGERS, Math.max(1, passengersRaw)),
      productId: (q.productId ?? "").trim() || undefined,
      lang: (q.lang ?? "").trim() || undefined,
      // A distance without a duration (or vice versa) cannot price anything,
      // so a half-supplied route is dropped rather than passed on partial.
      route:
        distanceMeters !== undefined && durationSeconds !== undefined
          ? { distanceMeters, durationSeconds }
          : undefined,
    },
  };
}
