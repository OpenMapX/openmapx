import type { LngLat } from "@openmapx/core";
import along from "@turf/along";
import { lineString } from "@turf/helpers";
import length from "@turf/length";
import lineSliceAlong from "@turf/line-slice-along";

export interface NavRouteLine {
  line: ReturnType<typeof lineString>;
  lengthKm: number;
  /**
   * Cumulative geodesic distance (km) from the route start to each vertex,
   * same length as the route geometry. This is the measure `@turf/along` and
   * `@turf/line-slice-along` walk internally (both sum per-segment geodesic
   * distance), so locating a distance in this table finds the identical
   * segment those functions land in.
   */
  cumulativeKm: number[];
  /**
   * Cumulative planar distance along the route in normalized Web-Mercator
   * [0,1] space — the measure MapLibre's `line-progress` accumulates.
   * Verified against `convertLine()` in `@maplibre/geojson-vt`'s
   * `convert.ts`: it walks the *unsimplified* coordinates and sums Euclidean
   * distance between successive `projectX`/`projectY` points, not geodesic
   * distance. The Mercator scale factor is `1 / cos(latitude)`, so this
   * diverges from `cumulativeKm` as soon as a route spans varying latitude —
   * that divergence is exactly why {@link navRouteProgressFraction} cannot
   * just divide `alongMeters` by `lengthKm`.
   */
  mercatorCumulative: number[];
  /** Total planar Mercator distance — the denominator for a `line-progress` fraction. */
  mercatorTotal: number;
}

/**
 * Longitude/latitude to normalized Web-Mercator [0,1], reproduced from
 * `projectX`/`projectY` in `@maplibre/geojson-vt`'s `convert.ts` (the source
 * `maplibre-gl` vendors for tiling GeoJSON sources). That is the exact math
 * `line-progress` accumulates over, so it has to be duplicated exactly rather
 * than approximated.
 */
function projectX(lng: number): number {
  return lng / 360 + 0.5;
}

function projectY(lat: number): number {
  const sin = Math.sin((lat * Math.PI) / 180);
  const y = 0.5 - (0.25 * Math.log((1 + sin) / (1 - sin))) / Math.PI;
  return y < 0 ? 0 : y > 1 ? 1 : y;
}

/**
 * Precompute the turf line + total geometric length for a route, plus the
 * cumulative geodesic and Mercator-planar distance tables {@link
 * navRouteProgressFraction} needs. This walks the whole polyline once (O(N));
 * callers cache it per route so neither this nor {@link splitNavRoute} re-walk
 * the full geometry on every GPS fix.
 */
export function buildNavRouteLine(geometry: LngLat[]): NavRouteLine | null {
  if (geometry.length < 2) return null;
  const line = lineString(geometry);

  const cumulativeKm: number[] = [0];
  const mercatorCumulative: number[] = [0];
  let prevMx = projectX(geometry[0][0]);
  let prevMy = projectY(geometry[0][1]);
  for (let i = 1; i < geometry.length; i++) {
    // A two-point `length()` call reduces to the same `@turf/distance` call
    // `along`/`lineSliceAlong` use per segment internally, so this table's
    // boundaries land exactly where those functions' internal walk does.
    const segmentKm = length(lineString([geometry[i - 1], geometry[i]]), { units: "kilometers" });
    cumulativeKm.push(cumulativeKm[i - 1] + segmentKm);

    const mx = projectX(geometry[i][0]);
    const my = projectY(geometry[i][1]);
    mercatorCumulative.push(mercatorCumulative[i - 1] + Math.hypot(mx - prevMx, my - prevMy));
    prevMx = mx;
    prevMy = my;
  }

  return {
    line,
    lengthKm: length(line, { units: "kilometers" }),
    cumulativeKm,
    mercatorCumulative,
    mercatorTotal: mercatorCumulative[mercatorCumulative.length - 1],
  };
}

/**
 * Convert an along-route geodesic distance (metres, as reported by the
 * navigation engine) into the `line-progress` fraction MapLibre's
 * `line-gradient` expects. `alongMeters / geodesicTotalMeters` is the wrong
 * formula — see {@link NavRouteLine.mercatorCumulative}'s doc comment for
 * why. This instead locates the same physical point {@link splitNavRoute}'s
 * "traveled" slice would cut at (same geodesic walk, same `@turf/along`
 * primitives `lineSliceAlong` uses), projects it into normalized-Mercator
 * space, and returns the planar fraction along that measure.
 *
 * Never throws and never returns `NaN`: degenerate geometry (fewer than two
 * points, or a `NaN` coordinate from a bad polyline decode — see the same
 * failure mode in `routeFlowBands.ts`) resolves to `0`.
 */
export function navRouteProgressFraction(prepared: NavRouteLine, alongMeters: number): number {
  const { cumulativeKm, mercatorCumulative, mercatorTotal, lengthKm, line } = prepared;
  if (cumulativeKm.length < 2) return 0;

  const totalMeters = lengthKm * 1000;
  if (!Number.isFinite(totalMeters) || totalMeters <= 0) return 0;
  if (!Number.isFinite(mercatorTotal) || mercatorTotal <= 0) return 0;

  // Clamping against the engine's reported distance rather than the
  // geometry's own length is deliberately wrong here — see splitNavRoute's
  // doc comment. A stale `alongMeters` from a previous (longer) route must
  // land at the line end, not throw or overshoot.
  const safeAlongMeters = Number.isNaN(alongMeters)
    ? 0
    : alongMeters === Number.POSITIVE_INFINITY
      ? totalMeters
      : alongMeters === Number.NEGATIVE_INFINITY
        ? 0
        : alongMeters;
  const alongKm = Math.min(Math.max(safeAlongMeters / 1000, 0), lengthKm);

  if (alongKm <= 0) return 0;
  if (alongKm >= lengthKm) return 1;

  // Locate the segment `alongKm` falls in, using the same cumulative
  // geodesic walk `along`/`lineSliceAlong` use internally.
  let segIdx = cumulativeKm.length - 2;
  for (let i = 0; i < cumulativeKm.length - 1; i++) {
    if (alongKm <= cumulativeKm[i + 1]) {
      segIdx = i;
      break;
    }
  }

  // The exact point splitNavRoute's traveled/remaining boundary cuts at.
  const point = along(line, alongKm, { units: "kilometers" });
  const [lng, lat] = point.geometry.coordinates;
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return 0;

  const segStart = line.geometry.coordinates[segIdx];
  const mercatorIntoSegment = Math.hypot(
    projectX(lng) - projectX(segStart[0]),
    projectY(lat) - projectY(segStart[1]),
  );

  const fraction = (mercatorCumulative[segIdx] + mercatorIntoSegment) / mercatorTotal;
  if (!Number.isFinite(fraction)) return 0;
  return Math.min(Math.max(fraction, 0), 1);
}

/**
 * Split a route polyline into "traveled" and "remaining" GeoJSON line features
 * at the given along-route distance (metres).
 *
 * The distance is clamped to the polyline's actual *geometric* length rather
 * than the engine's reported `route.distance`: turf slices by geometry, and the
 * two rarely match (the returned polyline is simplified, so its measured length
 * is a little shorter than the engine distance). Clamping against the engine
 * distance can therefore push the slice start past the line's end, which makes
 * `lineSliceAlong` throw "Start position is beyond line".
 *
 * This bites on reroute: when a new (shorter) route is applied the progress
 * still carries the previous route's much larger `alongMeters` for one render,
 * so the start lands well beyond the new geometry. Clamping with turf's own
 * `length` keeps the worst case at exactly the line end, which is safe.
 */
export function splitNavRoute(
  geometry: LngLat[],
  alongMeters: number,
  precomputed?: NavRouteLine,
): GeoJSON.Feature[] {
  if (geometry.length < 2) return [];

  const built = precomputed ?? buildNavRouteLine(geometry);
  if (!built) return [];
  const { line, lengthKm } = built;
  const alongKm = Math.min(Math.max(alongMeters / 1000, 0), lengthKm);

  const features: GeoJSON.Feature[] = [];
  if (alongKm > 0.001) {
    features.push({
      type: "Feature",
      properties: { kind: "traveled" },
      geometry: lineSliceAlong(line, 0, alongKm, { units: "kilometers" }).geometry,
    });
  }
  features.push({
    type: "Feature",
    properties: { kind: "remaining" },
    geometry: lineSliceAlong(line, alongKm, lengthKm, { units: "kilometers" }).geometry,
  });
  return features;
}
