import type { Feature, FeatureCollection, Polygon } from "geojson";

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

/** Wrap a longitude into [-180, 180). */
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

/** The antipode of `subsolarPoint` — the centre every twilight-band cap is built around. */
export function antisolarPoint(date: Date): { lng: number; lat: number } {
  const sub = subsolarPoint(date);
  return { lng: normalizeLongitude(sub.lng + 180), lat: -sub.lat };
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

export type ContourBranch = "pole" | "cap";

export interface DarkRegionProperties {
  altitudeDeg: number;
  branch: ContourBranch;
}

/** Great-circle destination from a point, given an angular distance and bearing in degrees. */
function destination(
  latDeg: number,
  lngDeg: number,
  distanceDeg: number,
  bearingDeg: number,
): [number, number] {
  const lat = latDeg * DEG;
  const d = distanceDeg * DEG;
  const brg = bearingDeg * DEG;
  const sinLat = Math.sin(lat) * Math.cos(d) + Math.cos(lat) * Math.sin(d) * Math.cos(brg);
  const destLat = Math.asin(Math.max(-1, Math.min(1, sinLat)));
  const destLng =
    lngDeg * DEG +
    Math.atan2(Math.sin(brg) * Math.sin(d) * Math.cos(lat), Math.cos(d) - Math.sin(lat) * sinLat);
  return [destLng * RAD, destLat * RAD];
}

/**
 * Ring for the case where the cap swallows a pole: every meridian crosses the
 * boundary exactly once, so a longitude sweep is single-valued and the ring
 * closes along the contained pole.
 *
 * sin(altitude) = A*sin(phi) + B*cos(phi) = R*sin(phi + psi), with
 * R = hypot(A, B) and psi = atan2(B, A). Solving for phi gives two
 * candidates 360 degrees apart in (phi + psi); of those, exactly one lands
 * in the valid latitude range [-90, 90] because a pole is inside the cap.
 */
function poleBranchRing(
  declinationDeg: number,
  greenwichHourAngleDeg: number,
  altitudeDeg: number,
  stepDeg: number,
  northInside: boolean,
): [number, number][] {
  const dec = declinationDeg * DEG;
  const A = Math.sin(dec);
  const C = Math.sin(altitudeDeg * DEG);
  const litPole = northInside ? -90 : 90;
  const darkPole = northInside ? 90 : -90;

  const ring: [number, number][] = [];
  for (let lng = -180; lng <= 180; lng += stepDeg) {
    const hourAngle = (greenwichHourAngleDeg + lng) * DEG;
    const B = Math.cos(dec) * Math.cos(hourAngle);
    const R = Math.hypot(A, B);

    if (R < 1e-12) {
      // R = hypot(A, B) >= |A| = |sin declination|, and the caller only takes
      // this branch when |declination| >= |altitudeDeg| = |C|, so R >= |C|
      // always holds except at this equinox degenerate meridian (declination
      // and cos(hourAngle) both ~0), which sits on the boundary everywhere.
      ring.push([lng, litPole]);
      continue;
    }

    const asinTerm = Math.asin(C / R) * RAD;
    const psiTerm = Math.atan2(B, A) * RAD;
    // These candidate values are latitudes, not longitudes, but the wrap into
    // [-180, 180) is the same modular arithmetic `normalizeLongitude` does.
    const near = normalizeLongitude(asinTerm - psiTerm);
    const far = normalizeLongitude(180 - asinTerm - psiTerm);
    const phi = Math.abs(near) <= 90.0000001 ? near : far;
    ring.push([lng, phi]);
  }

  ring.push([180, darkPole], [-180, darkPole], ring[0]);
  return ring;
}

/**
 * Ring for the case where the cap touches neither pole: sample bearings around
 * the antisolar point. Longitudes are left unwrapped so a ring crossing the
 * antimeridian stays continuous instead of folding back across the world.
 */
function capBranchRing(
  antiLat: number,
  antiLng: number,
  radiusDeg: number,
  stepDeg: number,
): [number, number][] {
  const ring: [number, number][] = [];
  let previousLng: number | null = null;

  for (let bearing = 0; bearing <= 360; bearing += stepDeg) {
    const [lng, lat] = destination(antiLat, antiLng, radiusDeg, bearing);
    let unwrapped = lng;
    if (previousLng !== null) {
      while (unwrapped - previousLng > 180) unwrapped -= 360;
      while (previousLng - unwrapped > 180) unwrapped += 360;
    }
    previousLng = unwrapped;
    ring.push([unwrapped, lat]);
  }

  ring[ring.length - 1] = [...ring[0]] as [number, number];
  return ring;
}

/**
 * The region where solar altitude is below `altitudeDeg`, as a spherical cap
 * centred on the antisolar point with angular radius `90 + altitudeDeg`.
 *
 * `altitudeDeg` must be at or below the horizon (<= 0). Above it the cap
 * radius (90 + altitudeDeg) would exceed 90 degrees and contain both poles,
 * which breaks the "at most one pole inside" premise the two branches rely on.
 */
export function darkRegion(
  date: Date,
  altitudeDeg: number,
  stepDeg = 1,
): Feature<Polygon, DarkRegionProperties> {
  if (altitudeDeg > 0) {
    throw new RangeError(
      "darkRegion requires altitudeDeg <= 0: above the horizon, the cap radius exceeds 90 degrees and swallows both poles",
    );
  }
  if (stepDeg <= 0 || 360 % stepDeg !== 0) {
    throw new RangeError(
      "darkRegion requires stepDeg > 0 and 360 % stepDeg === 0: a non-positive step never terminates the longitude sweep in poleBranchRing, and a step that doesn't evenly divide 360 skips its closing vertex and leaves a wedge unsampled in capBranchRing",
    );
  }

  const { declinationDeg, greenwichHourAngleDeg } = solarPosition(date);
  const northInside = declinationDeg <= altitudeDeg;
  const southInside = declinationDeg >= -altitudeDeg;

  let branch: ContourBranch;
  let ring: [number, number][];

  if (northInside || southInside) {
    branch = "pole";
    ring = poleBranchRing(declinationDeg, greenwichHourAngleDeg, altitudeDeg, stepDeg, northInside);
  } else {
    branch = "cap";
    const anti = antisolarPoint(date);
    ring = capBranchRing(anti.lat, anti.lng, 90 + altitudeDeg, stepDeg);
  }

  return {
    type: "Feature",
    geometry: { type: "Polygon", coordinates: [ring] },
    properties: { altitudeDeg, branch },
  };
}

export interface TwilightBandOptions {
  /** Number of nested contours. */
  bands?: number;
  /** Altitude of the innermost contour. */
  minAltitudeDeg?: number;
  /** Sampling resolution in degrees. */
  stepDeg?: number;
}

export interface TwilightBandProperties extends DarkRegionProperties {
  band: number;
}

/**
 * Nested dark-region contours from the horizon down towards astronomical night.
 * Rendered as stacked low-alpha fills, the accumulated alpha forms a continuous
 * ramp; nesting is guaranteed because the cap radius shrinks monotonically as
 * the altitude threshold falls.
 */
export function twilightBands(
  date: Date,
  options: TwilightBandOptions = {},
): FeatureCollection<Polygon, TwilightBandProperties> {
  const { bands = 16, minAltitudeDeg = -18, stepDeg = 1 } = options;
  const features: Feature<Polygon, TwilightBandProperties>[] = [];

  for (let band = 0; band < bands; band += 1) {
    // band 0 must be exactly 0, not -0: minAltitudeDeg * 0 is negative zero.
    const altitudeDeg = band === 0 ? 0 : (minAltitudeDeg * band) / bands;
    const region = darkRegion(date, altitudeDeg, stepDeg);
    features.push({ ...region, properties: { ...region.properties, band } });
  }

  return { type: "FeatureCollection", features };
}
