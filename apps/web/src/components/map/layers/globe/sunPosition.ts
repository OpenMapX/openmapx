import { subsolarPoint } from "@openmapx/core";

/**
 * Where the Sun and the sky are, in MapLibre's globe frame: a point at
 * longitude λ and latitude φ on the unit sphere is (sin λ·cos φ, sin φ, cos λ·cos φ).
 */

const RADIANS = Math.PI / 180;
const TWO_PI = 2 * Math.PI;
const UNIX_EPOCH_JULIAN_DAY = 2440587.5;
const J2000_JULIAN_DAY = 2451545;
const MS_PER_DAY = 86_400_000;

/** Greenwich mean sidereal time as an angle in [0, 2π). */
export function greenwichSiderealAngle(date: Date): number {
  const days = date.getTime() / MS_PER_DAY + UNIX_EPOCH_JULIAN_DAY - J2000_JULIAN_DAY;
  const angle = ((280.46061837 + 360.98564736629 * days) * RADIANS) % TWO_PI;
  return angle < 0 ? angle + TWO_PI : angle;
}

/** Unit vector from Earth's centre towards the Sun, in the globe frame. */
export function sunDirection(date: Date, out = new Float32Array(3)): Float32Array {
  const { lng, lat } = subsolarPoint(date);
  const longitude = lng * RADIANS;
  const latitude = lat * RADIANS;
  out[0] = Math.sin(longitude) * Math.cos(latitude);
  out[1] = Math.sin(latitude);
  out[2] = Math.cos(longitude) * Math.cos(latitude);
  return out;
}
