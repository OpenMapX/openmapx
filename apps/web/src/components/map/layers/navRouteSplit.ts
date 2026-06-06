import type { LngLat } from "@openmapx/core";
import { lineString } from "@turf/helpers";
import length from "@turf/length";
import lineSliceAlong from "@turf/line-slice-along";

export interface NavRouteLine {
  line: ReturnType<typeof lineString>;
  lengthKm: number;
}

/**
 * Precompute the turf line + total geometric length for a route. This walks the
 * whole polyline once (O(N)); callers cache it per route so {@link splitNavRoute}
 * doesn't re-walk the full geometry on every GPS fix.
 */
export function buildNavRouteLine(geometry: LngLat[]): NavRouteLine | null {
  if (geometry.length < 2) return null;
  const line = lineString(geometry);
  return { line, lengthKm: length(line, { units: "kilometers" }) };
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
