/**
 * Pure encoder for Valhalla's predicted-speed DCT-II payload
 * (`valhalla/baldr/utils.cc` / `predictedspeeds.h`, source-verified against
 * pyvalhalla's `compress_speed_buckets` / `encode_compressed_speeds`).
 *
 * A week is modeled as `BUCKETS_PER_WEEK` (2016) five-minute speed buckets
 * (7 days x 24 hours x 12 buckets/hour, Sunday-first). Valhalla compresses
 * that into `COEFFICIENT_COUNT` (200) DCT-II coefficients, rounds each to an
 * int16, and serializes them as 200 big-endian 2-byte values (400 bytes),
 * base64-encoded for storage in the traffic tile.
 */

/** Five-minute buckets in a full week: 7 days x 24 hours x 12 buckets/hour. */
const BUCKETS_PER_WEEK = 2016;
/** Number of DCT-II coefficients Valhalla keeps (the low-frequency ones). */
const COEFFICIENT_COUNT = 200;
/** Buckets per hour (5-minute resolution). */
const BUCKETS_PER_HOUR = 12;
/** Hours per day. */
const HOURS_PER_DAY = 24;
/** Days per week. */
const DAYS_PER_WEEK = 7;
/** Valhalla clamps predicted speeds to this range; out-of-range inputs are clamped, never rejected. */
const MIN_SPEED_KPH = 5;
const MAX_SPEED_KPH = 140;

/**
 * Rounds half away from zero, matching C++ `roundf`/`std::round` (which
 * Valhalla's encoder uses) rather than JS `Math.round` (which rounds half
 * toward +infinity). They diverge only at an exact `x.5` boundary for negative
 * values — `Math.round(-2.5) === -2` but `roundf(-2.5) === -3` — which would
 * flip a coefficient by ±1 and produce a different base64.
 */
export function roundHalfAwayFromZero(x: number): number {
  return Math.sign(x) * Math.round(Math.abs(x));
}

/**
 * Expands 168 hourly speeds (Sunday-first, `hourly[24*day + hour]`) into the
 * 2016 five-minute buckets Valhalla's DCT-II encoder expects. A `null` hour
 * falls back to `freeFlowKph`. Every value is clamped to `[5, 140]` km/h —
 * Valhalla only warns on out-of-range predicted speeds, it never re-clamps
 * them itself, so clamping happens here before encoding.
 */
export function expandHourlyToBuckets(
  hourly: readonly (number | null)[],
  freeFlowKph: number,
): number[] {
  const buckets = new Array<number>(BUCKETS_PER_WEEK);
  for (let d = 0; d < DAYS_PER_WEEK; d++) {
    for (let h = 0; h < HOURS_PER_DAY; h++) {
      const raw = hourly[HOURS_PER_DAY * d + h];
      const value = raw === null ? freeFlowKph : raw;
      const clamped = Math.min(MAX_SPEED_KPH, Math.max(MIN_SPEED_KPH, value));
      const base = BUCKETS_PER_HOUR * HOURS_PER_DAY * d + BUCKETS_PER_HOUR * h;
      for (let k = 0; k < BUCKETS_PER_HOUR; k++) {
        buckets[base + k] = clamped;
      }
    }
  }
  return buckets;
}

/**
 * Encodes 2016 five-minute speed buckets as Valhalla's base64 predicted-speed
 * payload: a forward DCT-II down to 200 coefficients, each rounded to an
 * int16, serialized as 200 big-endian 2-byte values (400 bytes) and
 * base64-encoded. Matches pyvalhalla's `compress_speed_buckets` +
 * `encode_compressed_speeds` byte-for-byte.
 */
export function encodePredictedSpeeds(buckets2016: readonly number[]): string {
  const buf = Buffer.alloc(COEFFICIENT_COUNT * 2);
  const dctScale = Math.sqrt(2 / BUCKETS_PER_WEEK);

  for (let c = 0; c < COEFFICIENT_COUNT; c++) {
    let sum = 0;
    for (let b = 0; b < BUCKETS_PER_WEEK; b++) {
      sum += buckets2016[b] * Math.cos((Math.PI / BUCKETS_PER_WEEK) * (b + 0.5) * c);
    }
    if (c === 0) sum *= 1 / Math.sqrt(2);
    sum *= dctScale;

    // roundHalfAwayFromZero matches Valhalla's roundf, not JS Math.round.
    const rounded = roundHalfAwayFromZero(sum);
    const clamped = Math.min(32767, Math.max(-32768, rounded));
    buf.writeInt16BE(clamped, c * 2);
  }

  return buf.toString("base64");
}
