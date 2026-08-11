const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

export interface SolarPosition {
  /** Solar declination in degrees, positive north. */
  declinationDeg: number;
  /** Greenwich hour angle of the sun in degrees, 0-360, increasing westward. */
  greenwichHourAngleDeg: number;
}

function norm360(deg: number): number {
  const v = deg % 360;
  return v < 0 ? v + 360 : v;
}

/** Wrap a longitude into [-180, 180]. */
export function normalizeLongitude(lng: number): number {
  return ((((lng + 180) % 360) + 360) % 360) - 180;
}

function julianDaysSinceJ2000(date: Date): number {
  return date.getTime() / 86_400_000 + 2440587.5 - 2451545.0;
}

/**
 * Low-precision NOAA solar position. Declination is accurate to roughly 0.01
 * degrees, which puts sunrise and sunset within about a minute below 65 degrees
 * of latitude — far tighter than a shading overlay resolves.
 */
export function solarPosition(date: Date): SolarPosition {
  const n = julianDaysSinceJ2000(date);
  const meanLongitude = norm360(280.46 + 0.9856474 * n);
  const meanAnomaly = norm360(357.528 + 0.9856003 * n) * DEG;
  const eclipticLongitude =
    (meanLongitude + 1.915 * Math.sin(meanAnomaly) + 0.02 * Math.sin(2 * meanAnomaly)) * DEG;
  const obliquity = (23.439 - 0.0000004 * n) * DEG;

  const rightAscension =
    Math.atan2(Math.cos(obliquity) * Math.sin(eclipticLongitude), Math.cos(eclipticLongitude)) *
    RAD;
  const declinationDeg = Math.asin(Math.sin(obliquity) * Math.sin(eclipticLongitude)) * RAD;

  const gmstHours = (((18.697374558 + 24.06570982441908 * n) % 24) + 24) % 24;

  return {
    declinationDeg,
    greenwichHourAngleDeg: norm360(gmstHours * 15 - rightAscension),
  };
}

/** The point on the surface where the sun is directly overhead. */
export function subsolarPoint(date: Date): { lng: number; lat: number } {
  const { declinationDeg, greenwichHourAngleDeg } = solarPosition(date);
  return { lng: normalizeLongitude(-greenwichHourAngleDeg), lat: declinationDeg };
}

/** Solar altitude above the horizon in degrees, negative below it. */
export function solarAltitudeDeg(date: Date, lat: number, lng: number): number {
  const { declinationDeg, greenwichHourAngleDeg } = solarPosition(date);
  const hourAngle = (greenwichHourAngleDeg + lng) * DEG;
  const phi = lat * DEG;
  const dec = declinationDeg * DEG;
  const sinAltitude =
    Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(hourAngle);
  return Math.asin(Math.max(-1, Math.min(1, sinAltitude))) * RAD;
}
