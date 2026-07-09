/**
 * Pure encoder for Valhalla's `TrafficSpeed` record (`valhalla/baldr/traffictile.h`,
 * source-verified against master 2026-07-04).
 *
 * `TrafficSpeed` is one 8-byte little-endian bitfield, LSB-first:
 * - `overall_encoded_speed` — bits 0-6
 * - `encoded_speed1`        — bits 7-13
 * - `encoded_speed2`        — bits 14-20
 * - `encoded_speed3`        — bits 21-27
 * - `breakpoint1`           — bits 28-35
 * - `breakpoint2`           — bits 36-43
 * - `congestion1`           — bits 44-49
 * - `congestion2`           — bits 50-55
 * - `congestion3`           — bits 56-61
 * - `has_incidents`         — bit 62
 * - `spare`                 — bit 63
 *
 * Speeds are stored as `kph >> 1` (2 km/h resolution). `127` is the
 * `UNKNOWN_TRAFFIC_SPEED_RAW` sentinel — never a real speed. `breakpoint1 == 0`
 * marks the record invalid/no-data (an all-zero record, as a fresh skeleton
 * contains, means "no live data"). A **valid record with overall speed `0`
 * means CLOSED** — `0` must never be written to represent "no data"; that's
 * what the unknown sentinel + `breakpoint1 = 0` is for.
 */

/** Max real (non-sentinel) `kph >> 1` value; 127 is reserved for "unknown". */
const MAX_REAL_ENCODED_SPEED = 126;
/** `UNKNOWN_TRAFFIC_SPEED_RAW` from `traffictile.h`. */
const UNKNOWN_TRAFFIC_SPEED_RAW = 127;
/** `breakpoint1`/`breakpoint2` value meaning "whole edge is one subsegment". */
const WHOLE_EDGE_BREAKPOINT = 255;

/**
 * Encodes a live speed (km/h) as an 8-byte little-endian `TrafficSpeed`
 * record. `null` (and any negative or non-finite input, which is treated the
 * same as `null`) produces the "unknown" sentinel record — used to clear a
 * previously-written edge back to "no live data".
 */
export function encodeTrafficSpeed(kph: number | null): Buffer {
  const buf = Buffer.alloc(8);

  const isUnknown = kph === null || !Number.isFinite(kph) || kph < 0;

  const overallEncodedSpeed = isUnknown
    ? UNKNOWN_TRAFFIC_SPEED_RAW
    : Math.min(Math.floor(kph / 2), MAX_REAL_ENCODED_SPEED);
  const encodedSpeed1 = overallEncodedSpeed;
  const breakpoint1 = isUnknown ? 0 : WHOLE_EDGE_BREAKPOINT;
  const breakpoint2 = isUnknown ? 0 : WHOLE_EDGE_BREAKPOINT;

  const value =
    (BigInt(overallEncodedSpeed) << 0n) |
    (BigInt(encodedSpeed1) << 7n) |
    (0n << 14n) | // encoded_speed2
    (0n << 21n) | // encoded_speed3
    (BigInt(breakpoint1) << 28n) |
    (BigInt(breakpoint2) << 36n) |
    (0n << 44n) | // congestion1
    (0n << 50n) | // congestion2
    (0n << 56n) | // congestion3
    (0n << 62n) | // has_incidents
    (0n << 63n); // spare

  buf.writeBigUInt64LE(value, 0);
  return buf;
}
