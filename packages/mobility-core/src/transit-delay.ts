/**
 * Pure per-leg delay derivations from a transit leg's realtime vs scheduled
 * timestamps. Kept provider-agnostic so any UI (nav banner, itinerary card,
 * arrival summary) can show a trustworthy delay without a separate trip fetch.
 */

/** Rounded seconds between two ISO timestamps, or undefined if either is unusable. */
function diffSeconds(actual?: string, scheduled?: string): number | undefined {
  if (!actual || !scheduled) return undefined;
  const diff = (new Date(actual).getTime() - new Date(scheduled).getTime()) / 1000;
  return Number.isFinite(diff) ? Math.round(diff) : undefined;
}

/**
 * Seconds the leg arrives later than scheduled (negative = early). Undefined
 * when either the realtime or scheduled arrival is missing/unparseable.
 */
export function legArrivalDelaySeconds(leg: {
  endTime?: string;
  scheduledEndTime?: string;
}): number | undefined {
  return diffSeconds(leg.endTime, leg.scheduledEndTime);
}

/**
 * Seconds the leg departs later than scheduled (negative = early). Undefined
 * when either the realtime or scheduled departure is missing/unparseable.
 */
export function legDepartureDelaySeconds(leg: {
  startTime?: string;
  scheduledStartTime?: string;
}): number | undefined {
  return diffSeconds(leg.startTime, leg.scheduledStartTime);
}
