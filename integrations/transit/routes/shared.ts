import type { BBox } from "@openmapx/core";
import { type BoundingBoxLimits, clampViewportBoundingBox } from "@openmapx/integration-framework";
import type { Attribution } from "@openmapx/mobility-core/attribution";
import type { Freshness } from "@openmapx/mobility-core/freshness";
import type { MobilityEnvelope, MobilityResult } from "@openmapx/mobility-core/result";

/**
 * Strip the server-only `trace` field from a MobilityResult and return the
 * `{ data, attributions, freshness }` envelope sent on the wire.
 */
export function toEnvelope<T>(result: MobilityResult<T>): MobilityEnvelope<T> {
  return {
    data: result.data,
    attributions: result.attributions,
    freshness: result.freshness,
  };
}

/** Build an envelope from raw data + a fresh attribution/freshness pair. */
export function envelope<T>(
  data: T,
  attributions: Attribution[],
  freshness: Freshness,
): MobilityEnvelope<T> {
  return { data, attributions, freshness };
}

/**
 * Browser and shared-cache policy for a result. A partial answer is not stored,
 * so a recovered source shows up on the next request. Set it once the result
 * exists, so a failed request doesn't carry a cacheable header either.
 */
export function cacheControl(freshness: Freshness, complete: string): string {
  return freshness.isPartial ? "no-store" : complete;
}

const TRANSIT_BBOX_LIMITS: BoundingBoxLimits = {
  maxLatitudeSpan: 30,
  maxLongitudeSpan: 60,
  maxArea: 900,
};

export function parseBBox(q: Record<string, string>): BBox | null {
  return clampViewportBoundingBox(
    { west: q.sw_lng, south: q.sw_lat, east: q.ne_lng, north: q.ne_lat },
    TRANSIT_BBOX_LIMITS,
  );
}

export function parseMinutes(raw: string | undefined, defaultVal = 60, max = 120): number | null {
  const minutes = Math.min(Number(raw ?? defaultVal), max);
  return Number.isFinite(minutes) && minutes > 0 ? minutes : null;
}

export function parseModes(raw: string | undefined): string[] | undefined {
  return raw ? raw.split(",").map((m) => m.trim()) : undefined;
}
