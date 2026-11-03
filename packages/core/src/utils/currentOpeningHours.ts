// Server-only context resolution. Keep the pinned boundary artifact and the
// LGPL opening_hours parser out of browser imports.
import type { LocationContext, OpeningHoursInfo } from "../types/openingHoursInfo";
import { buildOpeningHoursInfo, isOpenNow } from "./openingHours";

const VALID_FOR_MS = 60_000;
let jurisdictionModule: Promise<typeof import("@openmapx/air-quality/server")> | undefined;

function validCountry(code: string | undefined): string | undefined {
  return code && /^[a-z]{2}$/i.test(code) ? code.toLowerCase() : undefined;
}

/**
 * The location with the country a public-holiday rule needs: the given one,
 * else the country whose boundary holds the point when the hours name `PH`.
 */
async function withCountry(raw: string, location: LocationContext): Promise<LocationContext> {
  let countryCode = validCountry(location.countryCode);
  if (!countryCode && /\bPH\b/.test(raw)) {
    try {
      jurisdictionModule ??= import("@openmapx/air-quality/server");
      const { resolveJurisdiction } = await jurisdictionModule;
      const result = resolveJurisdiction({
        latitude: location.lat,
        longitude: location.lon,
        at: new Date().toISOString(),
      });
      if (result.resolution === "boundary-artifact") {
        countryCode = validCountry(result.countryCode ?? undefined);
      }
    } catch {
      // An unavailable or ambiguous boundary is not evidence for a country.
    }
  }
  return { ...location, countryCode };
}

/** Evaluates the final raw schedule for both list and detail responses. */
export async function currentOpeningHoursInfo(
  raw: string | undefined,
  location: LocationContext,
): Promise<OpeningHoursInfo | undefined> {
  if (!raw) return undefined;
  const info = buildOpeningHoursInfo(raw, await withCountry(raw, location));
  return info
    ? { ...info, validUntil: new Date(Date.now() + VALID_FOR_MS).toISOString() }
    : undefined;
}

/**
 * Whether a place is open right now by its raw hours; undefined without hours
 * or when they cannot be stated now. For filtering many places, where the full
 * `currentOpeningHoursInfo` would build a week's schedule for each.
 */
export async function currentlyOpen(
  raw: string | undefined,
  location: LocationContext,
): Promise<boolean | undefined> {
  if (!raw) return undefined;
  return isOpenNow(raw, await withCountry(raw, location));
}
