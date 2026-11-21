/**
 * Where the Sun is overhead, using the U.S. Naval Observatory's low-precision
 * almanac (about 0.01° between 1950 and 2050):
 * https://aa.usno.navy.mil/faq/sun_approx
 *
 * Vectors use MapLibre's globe frame, where a point at longitude λ and
 * latitude φ on the unit sphere is (sin λ·cos φ, sin φ, cos λ·cos φ).
 */

const RADIANS = Math.PI / 180;
const TWO_PI = 2 * Math.PI;
const UNIX_EPOCH_JULIAN_DAY = 2440587.5;
const J2000_JULIAN_DAY = 2451545;
const MS_PER_DAY = 86_400_000;

function daysSinceJ2000(date: Date): number {
  return date.getTime() / MS_PER_DAY + UNIX_EPOCH_JULIAN_DAY - J2000_JULIAN_DAY;
}

function wrapRadians(angle: number): number {
  const wrapped = angle % TWO_PI;
  return wrapped < 0 ? wrapped + TWO_PI : wrapped;
}

/** Greenwich mean sidereal time as an angle in [0, 2π). */
export function greenwichSiderealAngle(date: Date): number {
  return wrapRadians((280.46061837 + 360.98564736629 * daysSinceJ2000(date)) * RADIANS);
}

/** The point on Earth with the Sun at its zenith, in degrees, longitude in [-180, 180). */
export function subsolarPoint(date: Date): { lng: number; lat: number } {
  const n = daysSinceJ2000(date);
  const meanAnomaly = (357.529 + 0.98560028 * n) * RADIANS;
  const meanLongitude = 280.459 + 0.98564736 * n;
  const eclipticLongitude =
    (meanLongitude + 1.915 * Math.sin(meanAnomaly) + 0.02 * Math.sin(2 * meanAnomaly)) * RADIANS;
  const obliquity = (23.439 - 0.00000036 * n) * RADIANS;
  const declination = Math.asin(Math.sin(obliquity) * Math.sin(eclipticLongitude));
  const rightAscension = Math.atan2(
    Math.cos(obliquity) * Math.sin(eclipticLongitude),
    Math.cos(eclipticLongitude),
  );
  const longitude = wrapRadians(rightAscension - greenwichSiderealAngle(date) + Math.PI) - Math.PI;
  return { lng: longitude / RADIANS, lat: declination / RADIANS };
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
