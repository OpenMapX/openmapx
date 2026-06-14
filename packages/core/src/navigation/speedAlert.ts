/** Default tolerance (km/h) over the posted limit before flagging speeding. */
export const OVER_SPEED_TOLERANCE_KMH = 7;

/**
 * Whether the current ground speed exceeds the posted limit by more than the
 * tolerance. Returns false when no limit is known. `speedMps` is metres/second
 * (as reported by geolocation); `speedLimitKmh` is the posted limit in km/h.
 */
export function isOverSpeed(
  speedMps: number,
  speedLimitKmh: number | null,
  toleranceKmh: number = OVER_SPEED_TOLERANCE_KMH,
): boolean {
  if (speedLimitKmh === null || speedLimitKmh <= 0) return false;
  return speedMps * 3.6 > speedLimitKmh + toleranceKmh;
}
