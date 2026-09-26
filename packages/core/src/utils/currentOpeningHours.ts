// Server-only context resolution. Keep the pinned boundary artifact and the
// LGPL opening_hours parser out of browser imports.
import type { LocationContext, OpeningHoursInfo } from "../types/openingHoursInfo";
import { buildOpeningHoursInfo } from "./openingHours";

const VALID_FOR_MS = 60_000;
let jurisdictionModule: Promise<typeof import("@openmapx/air-quality/server")> | undefined;

function validCountry(code: string | undefined): string | undefined {
  return code && /^[a-z]{2}$/i.test(code) ? code.toLowerCase() : undefined;
}

/** Evaluates the final raw schedule for both list and detail responses. */
export async function currentOpeningHoursInfo(
  raw: string | undefined,
  location: LocationContext,
): Promise<OpeningHoursInfo | undefined> {
  if (!raw) return undefined;
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
  const info = buildOpeningHoursInfo(raw, { ...location, countryCode });
  return info
    ? { ...info, validUntil: new Date(Date.now() + VALID_FOR_MS).toISOString() }
    : undefined;
}
