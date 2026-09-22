import type { LngLat, RouteFlowSpan } from "@openmapx/core";
import { lineString } from "@turf/helpers";
import length from "@turf/length";
import lineSliceAlong from "@turf/line-slice-along";
import type * as maplibregl from "maplibre-gl";

/** Bands shorter than this survive neither rounding nor a glance. */
export const MIN_DRAWN_METERS = 25;

export interface BandRoute {
  id: string;
  geometry: LngLat[];
  variant: "active" | "alt";
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

interface PreparedRouteLine {
  geometry: LngLat[];
  kilometers: Float64Array;
  totalMeters: number;
}

const preparedRoutes = new WeakMap<LngLat[], PreparedRouteLine>();

/** The cumulative Turf metric is built once for each immutable route geometry. */
function prepareRouteLine(geometry: LngLat[]): PreparedRouteLine | null {
  if (geometry.length < 2) return null;
  const cached = preparedRoutes.get(geometry);
  if (cached) return cached;
  const kilometers = new Float64Array(geometry.length);
  for (let i = 1; i < geometry.length; i++) {
    kilometers[i] = kilometers[i - 1] + length(lineString([geometry[i - 1], geometry[i]]));
  }
  const prepared = { geometry, kilometers, totalMeters: kilometers[geometry.length - 1] * 1000 };
  preparedRoutes.set(geometry, prepared);
  return prepared;
}

function lowerBound(distances: Float64Array, value: number): number {
  let lo = 0;
  let hi = distances.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (distances[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Slice `[start, end]` out of `line`, clamped against turf's own measured
 * length rather than the engine's reported distance (the drawn polyline is
 * simplified, so the two rarely match, and slicing past the end throws) and
 * dropped if what survives the clamp is imperceptibly short.
 */
function sliceSpanFeature(
  prepared: PreparedRouteLine,
  start: number,
  end: number,
): GeoJSON.Feature<GeoJSON.LineString> | null {
  const { totalMeters, kilometers, geometry } = prepared;
  const clampedStart = Math.max(0, Math.min(start, totalMeters));
  const clampedEnd = Math.max(0, Math.min(end, totalMeters));
  if (clampedEnd - clampedStart < MIN_DRAWN_METERS) return null;
  try {
    if (!Number.isFinite(totalMeters)) return null;
    const startKm = clampedStart / 1000;
    const endKm = clampedEnd / 1000;
    const first = Math.max(0, lowerBound(kilometers, startKm) - 1);
    const last = Math.max(first + 1, lowerBound(kilometers, endKm));
    const window = lineString(geometry.slice(first, last + 1));
    return lineSliceAlong(window, startKm - kilometers[first], endKm - kilometers[first], {
      units: "kilometers",
    });
  } catch {
    // Reachable when route.geometry itself is degenerate (a bad polyline
    // decode leaves a NaN coordinate): `length` then returns NaN, which both
    // Math.min/Math.max pass straight through unclamped, and turf throws on
    // the NaN offsets. Drop just this span rather than losing every other
    // route's bands in the same batch.
    return null;
  }
}

/**
 * Every span of every route, untrimmed — the whole picture, independent of
 * how far the driver has gotten. `startMeters`/`endMeters` on each feature
 * carry the *raw* span offsets (not the clamped slice geometry's own
 * extent), because {@link activeSpanFilter} compares against them to decide
 * whether a given span is still ahead of the driver.
 */
export function buildStaticSpanFeatures(
  routes: readonly BandRoute[],
  spansByRoute: Record<string, RouteFlowSpan[]>,
): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = [];
  for (const route of routes) {
    const spans = spansByRoute[route.id];
    if (!spans || spans.length === 0) continue;
    const prepared = prepareRouteLine(route.geometry);
    if (!prepared) continue;
    for (const span of spans) {
      const sliced = sliceSpanFeature(prepared, span.startMeters, span.endMeters);
      if (!sliced) continue;
      features.push({
        type: "Feature",
        geometry: sliced.geometry,
        properties: {
          variant: route.variant,
          los: span.los,
          confidence: span.confidence,
          speedRatio: span.speedRatio ?? null,
          routeId: route.id,
          startMeters: span.startMeters,
          endMeters: span.endMeters,
        },
      });
    }
  }
  return { type: "FeatureCollection", features };
}

/**
 * The one (occasionally more, for overlapping input) span the driver is
 * currently inside, trimmed to start at `alongMeters`. Everything the driver
 * has fully passed, or hasn't reached yet, belongs in {@link
 * buildStaticSpanFeatures} instead — this is only ever a handful of
 * features, cheap to re-publish every GPS fix.
 *
 * Mirrors {@link clipSpans}'s own `alongMeters <= 0` early return: at the
 * route start (or in planning mode, where no progress applies at all)
 * nothing is "current" yet, even a span with a stray negative `startMeters`.
 */
export function buildCurrentSpanFeatures(
  route: BandRoute,
  spans: readonly RouteFlowSpan[],
  alongMeters: number,
): GeoJSON.Feature[] {
  if (alongMeters <= 0) return [];
  const eligible = spans.filter(
    (span) =>
      !(span.startMeters >= alongMeters) && !(span.endMeters - alongMeters < MIN_DRAWN_METERS),
  );
  if (eligible.length === 0) return [];
  const prepared = prepareRouteLine(route.geometry);
  if (!prepared) return [];

  const features: GeoJSON.Feature[] = [];
  for (const span of eligible) {
    const sliced = sliceSpanFeature(prepared, alongMeters, span.endMeters);
    if (!sliced) continue;
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
  return features;
}

/**
 * The filter for the static active-route layer: everything still ahead of
 * the driver. At `alongMeters <= 0` this must drop the `startMeters` term
 * entirely rather than compare `0 <= startMeters` — {@link clipSpans}'s own
 * `alongMeters <= 0` case keeps every span untouched, including one with a
 * negative `startMeters`, and a `<=` comparison would wrongly filter that
 * span out.
 */
export function activeSpanFilter(alongMeters: number): maplibregl.FilterSpecification {
  if (alongMeters <= 0) {
    return ["==", ["get", "variant"], "active"];
  }
  return [
    "all",
    ["==", ["get", "variant"], "active"],
    ["<=", alongMeters, ["get", "startMeters"]],
  ] as maplibregl.FilterSpecification;
}
