import {
  closesRoadForCars,
  effectInForceAt,
  haversineDistance,
  isLocalAccessClosure,
  isRoutingRelevantBinding,
  type LngLat,
} from "@openmapx/core";
import { type BoundCondition, conditionRoutingDecision } from "./conditions-to-edges.js";

/**
 * A point on a closed carriageway and the direction it is closed in, in
 * degrees clockwise from north. An engine that excludes the edge under the
 * point only for travel within a tolerance of `heading` closes that one
 * direction: the other direction of a two-way road keeps routing.
 */
export interface DirectedSample {
  lon: number;
  lat: number;
  heading: number;
}

/** One closure a trip at a given instant must route around, as directed samples along its spans. */
export interface PlannedClosure {
  /** `<recordId>#<effectId>`, as the conditions feed and receipts name it. */
  id: string;
  source: string;
  /** Open to residents and deliveries: an end of the route may still lie on it. */
  localAccess: boolean;
  /** When this answer lapses: the source's freshness or the effect's own deadline. */
  validUntil: string;
  /** In span order, each in its span's direction of travel. */
  samples: DirectedSample[];
}

export interface PlannedClosuresResult {
  closures: PlannedClosure[];
  /**
   * Closures in force at the travel instant, anywhere in the snapshot, whose
   * spans carry no geometry: no point can stand for them, so a route may cross
   * them. Not limited to the box, which needs that geometry to test.
   */
  unrepresentable: number;
}

/** Samples along a span sit at most this far apart, so a route entering mid-span still meets one. */
const SAMPLE_SPACING_M = 100;
/**
 * Samples keep this far from a span's ends: an end lies on a junction node,
 * where a point would snap to whichever edge leaves it, closed or not.
 */
const END_MARGIN_M = 15;

/** Initial bearing from `a` to `b`, degrees clockwise from north in [0, 360). */
function bearing(a: LngLat, b: LngLat): number {
  const toRad = Math.PI / 180;
  const dLon = (b[0] - a[0]) * toRad;
  const lat1 = a[1] * toRad;
  const lat2 = b[1] * toRad;
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return (((Math.atan2(y, x) / toRad) % 360) + 360) % 360;
}

const round = (v: number, places: number) => Math.round(v * 10 ** places) / 10 ** places;

/**
 * Directed samples along one span's geometry, in travel direction: at most
 * the sample spacing apart, none within the end margin of either end. A span
 * too short for that margin gets one sample at its middle.
 */
export function sampleSpan(geometry: readonly LngLat[]): DirectedSample[] {
  const lengths: number[] = [];
  let total = 0;
  for (let i = 1; i < geometry.length; i++) {
    const d = haversineDistance(geometry[i - 1] as LngLat, geometry[i] as LngLat);
    lengths.push(d);
    total += d;
  }
  if (total === 0) return [];
  const usable = total - 2 * END_MARGIN_M;
  const offsets: number[] = [];
  if (usable <= 0) {
    offsets.push(total / 2);
  } else {
    // `gaps` intervals of at most SAMPLE_SPACING_M between the two margins.
    const gaps = Math.ceil(usable / SAMPLE_SPACING_M);
    if (gaps === 0) offsets.push(total / 2);
    for (let k = 0; gaps > 0 && k <= gaps; k++) offsets.push(END_MARGIN_M + (k * usable) / gaps);
  }
  const samples: DirectedSample[] = [];
  let segment = 0;
  let start = 0;
  for (const offset of offsets) {
    while (segment < lengths.length - 1 && start + (lengths[segment] as number) < offset) {
      start += lengths[segment] as number;
      segment++;
    }
    const a = geometry[segment] as LngLat;
    const b = geometry[segment + 1] as LngLat;
    const len = lengths[segment] as number;
    // A zero-length segment has no direction of its own; it never carries a sample.
    if (len === 0) continue;
    const t = Math.min(1, Math.max(0, (offset - start) / len));
    samples.push({
      lon: round(a[0] + (b[0] - a[0]) * t, 7),
      lat: round(a[1] + (b[1] - a[1]) * t, 7),
      heading: round(bearing(a, b), 1),
    });
  }
  return samples;
}

function inBox(
  s: DirectedSample,
  [west, south, east, north]: readonly [number, number, number, number],
): boolean {
  return s.lon >= west && s.lon <= east && s.lat >= south && s.lat <= north;
}

/**
 * The bound closures a car trip at `travelAt` must route around, as seen at
 * the wall clock `evaluatedAt`: a routable binding from an origin that may
 * route, an effect that closes the road to every car, eligible by core's
 * routing decision for that travel instant and in force inside its own window
 * then (recurring periods included). Only closures with a sample inside
 * `bbox` ([west, south, east, north]) are returned.
 *
 * Unlike the live-traffic write, nothing here depends on the engine having
 * applied the closure: the caller excludes the samples per request and checks
 * the returned route against them.
 */
export function plannedClosures(
  conditions: readonly BoundCondition[],
  options: {
    bbox: readonly [number, number, number, number];
    travelAt: number;
    evaluatedAt: number;
    disallowedSources?: ReadonlySet<string>;
  },
): PlannedClosuresResult {
  const closures: PlannedClosure[] = [];
  let unrepresentable = 0;
  const now = new Date(options.evaluatedAt);
  const at = new Date(options.travelAt);
  for (const condition of conditions) {
    if (!isRoutingRelevantBinding(condition.bindingStatus)) continue;
    if (!closesRoadForCars(condition.effect)) continue;
    const decision = conditionRoutingDecision(condition, {
      evaluatedAt: options.evaluatedAt,
      travelAt: options.travelAt,
      disallowedSources: options.disallowedSources,
    });
    if (!decision.eligible || decision.validUntil === null) continue;
    const e = condition.routingEvidence;
    const situation = {
      validity: {
        status: "active" as const,
        ...(e.valid_from ? { start: e.valid_from } : {}),
        ...(e.valid_to ? { end: e.valid_to } : {}),
      },
    };
    if (!effectInForceAt(situation, condition.effect, at, now)) continue;
    if (condition.segments.some((span) => !span.geometry)) {
      unrepresentable++;
      continue;
    }
    const samples = condition.segments.flatMap((span) => sampleSpan(span.geometry ?? []));
    if (samples.length === 0) {
      unrepresentable++;
      continue;
    }
    if (!samples.some((s) => inBox(s, options.bbox))) continue;
    closures.push({
      id: condition.id,
      source: condition.source,
      localAccess: isLocalAccessClosure(condition.effect),
      validUntil: decision.validUntil,
      samples,
    });
  }
  return { closures, unrepresentable };
}
