import type { TripItinerary } from "@openmapx/mobility-core/transit";
import { type TransitNavigationStartPackage, transitStartPackageSchema } from "./mobileProtocol";
import { captureTransitLegStops, type JourneyStopLike } from "./transitStops";

/**
 * Turning a planned itinerary into something the shell can follow with no
 * network at all.
 *
 * A planned trip alone is not enough: it says which train, not which stops that
 * train makes. Counting stops is how a rider knows when to get off, so the
 * package carries a *capture* — the board-to-alight slice of each ride — taken
 * while the connection still worked.
 *
 * Two rules keep it honest:
 *
 *  - **Nothing is invented.** A journey the server could not supply becomes an
 *    explicit `missing` capture, and the shell falls back to the itinerary's own
 *    times. It never guesses intermediate stops.
 *  - **Identity excludes what changes.** The fingerprint covers the structural
 *    shape of the trip — legs, trips, endpoints, scheduled times — and excludes
 *    the rotating refresh token and live timestamps, so a refresh that updates a
 *    delay does not read as a different journey.
 */

export type TransitPackageError = "invalid-package" | "no-destination";

export interface BuildTransitPackageInput {
  itinerary: TripItinerary;
  /** Ridden stop lists by trip id, as fetched while the connection worked. */
  journeys: Readonly<Record<string, readonly JourneyStopLike[] | undefined>>;
  replanOptions?: Record<string, unknown>;
  locale: "en" | "de";
  units: "metric" | "imperial";
  settings: { voiceEnabled: boolean; keepScreenOn: boolean; alightAlertsEnabled: boolean };
  capturedAtMs: number;
}

export type BuildTransitPackageResult =
  | { ok: true; startPackage: TransitNavigationStartPackage }
  | { ok: false; code: TransitPackageError };

/**
 * A structural identity for the trip.
 *
 * Built from a canonical string rather than a hash of the whole object: a hash
 * over everything would change whenever a delay did, and the point of this value
 * is to stay the same across a refresh so progress survives it.
 */
export function transitItineraryFingerprint(itinerary: TripItinerary): string {
  const parts: string[] = [];
  for (const [index, leg] of (itinerary.legs ?? []).entries()) {
    parts.push(
      [
        index,
        leg.mode ?? "",
        // `TripLeg.route` carries presentation fields; the trip id below is the
        // stable identity, so the route contributes its short name only.
        leg.route?.shortName ?? "",
        leg.tripId ?? "",
        leg.from?.stopId ?? leg.from?.name ?? "",
        leg.to?.stopId ?? leg.to?.name ?? "",
        // Scheduled times are part of the plan; live ones are what refresh moves.
        leg.scheduledStartTime ?? "",
        leg.scheduledEndTime ?? "",
      ].join("|"),
    );
  }
  let hash = 0x811c9dc5 >>> 0;
  const canonical = parts.join("\n");
  for (let index = 0; index < canonical.length; index += 1) {
    hash ^= canonical.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `it-${hash.toString(36)}-${parts.length}`;
}

/**
 * Builds the captured package, or explains why it cannot.
 *
 * The per-leg slicing — including the explicit `missing` capture when a journey
 * could not be fetched — belongs to `captureTransitLegStops`, which the browser
 * already uses. Reimplementing it here would be a second answer to "which stops
 * does this train make between boarding and alighting", and the two would drift.
 */
export function buildTransitNavigationPackage(
  input: BuildTransitPackageInput,
): BuildTransitPackageResult {
  const legs = input.itinerary.legs ?? [];
  const destination = legs[legs.length - 1]?.to;
  if (!destination) return { ok: false, code: "no-destination" };

  const captures = captureTransitLegStops(legs as never, input.journeys, input.capturedAtMs);

  const candidate = {
    kind: "transit" as const,
    itinerary: input.itinerary as unknown as Record<string, unknown>,
    captures,
    ...(input.replanOptions ? { replanOptions: input.replanOptions } : {}),
    locale: input.locale,
    units: input.units,
    settings: input.settings,
    itineraryFingerprint: transitItineraryFingerprint(input.itinerary),
  };

  const parsed = transitStartPackageSchema.safeParse(candidate);
  if (!parsed.success) return { ok: false, code: "invalid-package" };
  return { ok: true, startPackage: parsed.data };
}

/**
 * Removes the rotating refresh token from anything leaving native.
 *
 * Recursive and key-based rather than shape-based: the token can sit anywhere in
 * an itinerary the server shaped, and a projection that only knew about the
 * places it appears today would leak the first time the server moved it.
 */
export function stripTransitSecretsForSnapshot<T>(value: T): T {
  return strip(value, 0) as T;
}

const SECRET_KEYS = new Set(["refreshToken", "refresh_token", "token"]);

function strip(value: unknown, depth: number): unknown {
  if (depth > 32 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => strip(item, depth + 1));

  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEYS.has(key)) continue;
    result[key] = strip(child, depth + 1);
  }
  return result;
}
