import type { FixInput } from "@openmapx/core/navigation";
import { type CanonicalLocationFix, type RawLocation, sanitiseRawLocations } from "./rawLocation";

export type { RawLocation } from "./rawLocation";
export { MAX_FIX_AGE_MS, MAX_FIX_SKEW_MS } from "./rawLocation";

/**
 * Turns whatever the operating system delivered into fixes the engine may act
 * on — or into nothing at all.
 *
 * A batch is not a trustworthy sequence. It can arrive out of order, repeat a
 * fix already processed, replay a stale cache after a wake-up, or carry a
 * timestamp from a clock that just changed. Every one of those would move the
 * user backwards along a route, so the batch is sorted, deduplicated and
 * clipped to a monotonic watermark before anything is written.
 */

export interface SanitisedBatch {
  accepted: FixInput[];
  rejectedCount: number;
}

function toFix(fix: CanonicalLocationFix): FixInput {
  return {
    coords: fix.coords,
    accuracy: fix.accuracy,
    timestampMs: fix.timestampMs,
    ...(fix.speedMps !== undefined ? { speed: fix.speedMps } : {}),
    ...(fix.headingDegrees !== undefined ? { heading: fix.headingDegrees } : {}),
  };
}

export function sanitiseFixes(
  locations: readonly RawLocation[],
  nowMs: number,
  lastAcceptedTimestampMs: number | null,
): SanitisedBatch {
  const batch = sanitiseRawLocations(locations, nowMs, lastAcceptedTimestampMs);
  return { accepted: batch.accepted.map(toFix), rejectedCount: batch.rejectedCount };
}
