/**
 * Input validators for the routing HTTP routes. Pulled out of `index.ts` so
 * they're trivially unit-testable without standing up a Fastify host.
 */

import type { TravelMode } from "@openmapx/core";

const ALLOWED_TRAVEL_MODES: readonly TravelMode[] = [
  "driving",
  "walking",
  "cycling",
  "motorcycle",
  "transit",
] as const;

/**
 * Validate that `value` is one of the supported travel modes. Returns the
 * narrowed mode on success, throws on unknown input. The caller decides what
 * to do with `transit` — most route handlers reject it with a redirect to
 * `/api/transit/plan`, but `parseTravelMode` itself doesn't gate on that.
 */
export function parseTravelMode(value: string | undefined): TravelMode {
  const candidate = (value ?? "driving").toLowerCase();
  if (!ALLOWED_TRAVEL_MODES.includes(candidate as TravelMode)) {
    throw new Error(`Invalid mode: "${value}". Expected one of ${ALLOWED_TRAVEL_MODES.join(", ")}`);
  }
  return candidate as TravelMode;
}

/**
 * Validate and normalise an ISO-8601 date-time query param to the routing API's
 * `YYYY-MM-DDTHH:mm` wall-clock format. Accepts inputs with optional seconds,
 * milliseconds, and timezone (which are stripped — the API treats the
 * supplied wall-clock as local time at the route origin).
 *
 * Throws if the input doesn't begin with a valid date-time prefix or names a
 * non-existent calendar date (e.g. Feb 31).
 */
export function parseDateTime(value: string | undefined, name: string): string | undefined {
  if (value === undefined || value === "") return undefined;
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) {
    throw new Error(`Invalid ${name}: expected ISO-8601 datetime (YYYY-MM-DDTHH:mm)`);
  }
  const [, y, mo, d, h, mi] = m;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  const hour = Number(h);
  const minute = Number(mi);

  // Cheap range check rejects most malformed inputs without constructing a Date.
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) {
    throw new Error(`Invalid ${name}: out-of-range date or time component`);
  }

  // Calendar correctness — Date round-trips Feb 30 to Mar 2, etc.
  // We compare the UTC components we constructed from to catch those.
  const probe = new Date(Date.UTC(year, month - 1, day, hour, minute));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day ||
    probe.getUTCHours() !== hour ||
    probe.getUTCMinutes() !== minute
  ) {
    throw new Error(`Invalid ${name}: not a real calendar date (${y}-${mo}-${d})`);
  }

  return `${y}-${mo}-${d}T${h}:${mi}`;
}
