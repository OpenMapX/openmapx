import type { FixInput } from "@openmapx/core/navigation";

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

/** Shape of `expo-location`'s task payload, narrowed to what is actually read. */
export interface RawLocation {
  timestamp: number;
  coords: {
    latitude: number;
    longitude: number;
    accuracy?: number | null;
    speed?: number | null;
    heading?: number | null;
    altitude?: number | null;
  };
}

/** A fix older than this relative to now is treated as a replayed artefact. */
export const MAX_FIX_AGE_MS = 5 * 60_000;
/** Tolerated forward clock skew between the OS fix clock and the app's clock. */
export const MAX_FIX_SKEW_MS = 2 * 60_000;

export interface SanitisedBatch {
  accepted: FixInput[];
  rejectedCount: number;
}

function toFix(raw: RawLocation, nowMs: number): FixInput | null {
  if (!raw || typeof raw !== "object") return null;
  const { timestamp, coords } = raw;
  if (!Number.isFinite(timestamp) || timestamp <= 0) return null;
  if (timestamp < nowMs - MAX_FIX_AGE_MS) return null;
  if (timestamp > nowMs + MAX_FIX_SKEW_MS) return null;
  if (!coords || typeof coords !== "object") return null;

  const { latitude, longitude, accuracy } = coords;
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) return null;
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) return null;
  // A fix without a usable accuracy cannot be judged against the engine's
  // accuracy cap later, so it is refused rather than assumed good.
  if (typeof accuracy !== "number" || !Number.isFinite(accuracy) || accuracy < 0) return null;

  return {
    coords: [longitude, latitude],
    accuracy,
    timestampMs: timestamp,
    ...(typeof coords.speed === "number" && Number.isFinite(coords.speed) && coords.speed >= 0
      ? { speed: coords.speed }
      : {}),
    ...(typeof coords.heading === "number" && Number.isFinite(coords.heading)
      ? { heading: coords.heading }
      : {}),
  };
}

export function sanitiseFixes(
  locations: readonly RawLocation[],
  nowMs: number,
  lastAcceptedTimestampMs: number | null,
): SanitisedBatch {
  const candidates: FixInput[] = [];
  let rejectedCount = 0;
  for (const raw of locations) {
    const fix = toFix(raw, nowMs);
    if (fix) candidates.push(fix);
    else rejectedCount += 1;
  }
  candidates.sort((a, b) => a.timestampMs - b.timestampMs);

  const accepted: FixInput[] = [];
  let watermark = lastAcceptedTimestampMs ?? Number.NEGATIVE_INFINITY;
  for (const fix of candidates) {
    // Equal timestamps are the same instant, not new information.
    if (fix.timestampMs <= watermark) continue;
    watermark = fix.timestampMs;
    accepted.push(fix);
  }
  return { accepted, rejectedCount };
}
