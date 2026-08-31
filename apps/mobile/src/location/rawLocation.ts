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

export interface CanonicalLocationFix {
  coords: [number, number];
  accuracy: number;
  timestampMs: number;
  speedMps?: number;
  headingDegrees?: number;
}

export interface SanitisedRawLocationBatch {
  accepted: CanonicalLocationFix[];
  rejectedCount: number;
}

export const MAX_FIX_AGE_MS = 5 * 60_000;
export const MAX_FIX_SKEW_MS = 2 * 60_000;

function toCanonicalFix(raw: RawLocation, nowMs: number): CanonicalLocationFix | null {
  if (!raw || typeof raw !== "object") return null;
  const { timestamp, coords } = raw;
  if (!Number.isFinite(timestamp) || timestamp <= 0) return null;
  if (timestamp < nowMs - MAX_FIX_AGE_MS) return null;
  if (timestamp > nowMs + MAX_FIX_SKEW_MS) return null;
  if (!coords || typeof coords !== "object") return null;

  const { latitude, longitude, accuracy, speed, heading } = coords;
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) return null;
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) return null;
  if (typeof accuracy !== "number" || !Number.isFinite(accuracy) || accuracy < 0) return null;

  return {
    coords: [longitude, latitude],
    accuracy,
    timestampMs: timestamp,
    ...(typeof speed === "number" && Number.isFinite(speed) && speed >= 0
      ? { speedMps: speed }
      : {}),
    ...(typeof heading === "number" && Number.isFinite(heading) && heading >= 0 && heading <= 360
      ? { headingDegrees: heading }
      : {}),
  };
}

export function sanitiseRawLocations(
  locations: readonly RawLocation[],
  nowMs: number,
  lastAcceptedTimestampMs: number | null,
): SanitisedRawLocationBatch {
  const candidates: CanonicalLocationFix[] = [];
  let rejectedCount = 0;
  for (const raw of locations) {
    const fix = toCanonicalFix(raw, nowMs);
    if (fix) candidates.push(fix);
    else rejectedCount += 1;
  }
  candidates.sort((a, b) => a.timestampMs - b.timestampMs);

  const accepted: CanonicalLocationFix[] = [];
  let watermark = lastAcceptedTimestampMs ?? Number.NEGATIVE_INFINITY;
  for (const fix of candidates) {
    if (fix.timestampMs <= watermark) continue;
    watermark = fix.timestampMs;
    accepted.push(fix);
  }
  return { accepted, rejectedCount };
}
