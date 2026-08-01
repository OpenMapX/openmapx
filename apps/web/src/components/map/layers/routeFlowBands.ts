import type { LngLat, RouteFlowSpan } from "@openmapx/core";
import { lineString } from "@turf/helpers";
import length from "@turf/length";
import lineSliceAlong from "@turf/line-slice-along";

/** Bands shorter than this survive neither rounding nor a glance. */
const MIN_DRAWN_METERS = 25;

export interface BandRoute {
  id: string;
  geometry: LngLat[];
  variant: "active" | "alt";
  /** Metres already driven. Bands behind it are gone, the current one is trimmed. */
  alongMeters?: number;
}

/** Drop what the driver has passed and trim the jam they are already inside. */
export function clipSpans(spans: readonly RouteFlowSpan[], alongMeters: number): RouteFlowSpan[] {
  if (alongMeters <= 0) return [...spans];
  const out: RouteFlowSpan[] = [];
  for (const span of spans) {
    if (span.endMeters - alongMeters < MIN_DRAWN_METERS) continue;
    out.push(span.startMeters >= alongMeters ? span : { ...span, startMeters: alongMeters });
  }
  return out;
}

/**
 * Slice each span out of its route's polyline. The band is a piece of the drawn
 * line, not the road segment the observation came from, which is what makes it
 * sit exactly on the route instead of wobbling alongside it.
 *
 * Offsets are clamped against turf's measured length rather than the engine's
 * reported distance: the drawn polyline is simplified, so the two differ, and
 * slicing past the end throws.
 */
export function buildBandFeatures(
  routes: readonly BandRoute[],
  spansByRoute: Record<string, RouteFlowSpan[]>,
): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = [];
  for (const route of routes) {
    const spans = spansByRoute[route.id];
    if (!spans || spans.length === 0 || route.geometry.length < 2) continue;
    const line = lineString(route.geometry);
    const totalMeters = length(line, { units: "kilometers" }) * 1000;
    for (const span of clipSpans(spans, route.alongMeters ?? 0)) {
      const start = Math.max(0, Math.min(span.startMeters, totalMeters));
      const end = Math.max(0, Math.min(span.endMeters, totalMeters));
      if (end - start < MIN_DRAWN_METERS) continue;
      let sliced: GeoJSON.Feature<GeoJSON.LineString>;
      try {
        sliced = lineSliceAlong(line, start / 1000, end / 1000, { units: "kilometers" });
      } catch {
        // Reachable when route.geometry itself is degenerate (a bad polyline
        // decode leaves a NaN coordinate): `length` then returns NaN, which
        // both Math.min/Math.max pass straight through unclamped, and turf
        // throws on the NaN offsets. Drop just this span rather than losing
        // every other route's bands in the same batch.
        continue;
      }
      features.push({
        type: "Feature",
        geometry: sliced.geometry,
        properties: {
          variant: route.variant,
          los: span.los,
          confidence: span.confidence,
          speedRatio: span.speedRatio ?? null,
        },
      });
    }
  }
  return { type: "FeatureCollection", features };
}
