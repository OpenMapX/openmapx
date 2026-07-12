import type { BBox } from "@openmapx/core";
import { haversineDistance } from "@openmapx/core";
import type {
  IntegrationContext,
  RoadConditionSchedule,
  RoadConditionsProvider,
} from "@openmapx/integration-framework";
import { localDateInZone, zonedWallClockToInstant } from "./timezone.js";

export type LngLat = [number, number];

export interface ClosureExclusions {
  points: LngLat[];
  polygons: LngLat[][];
}

/** Severity threshold: only events at this level or above are treated as exclusions. */
const CLOSURE_TYPES = new Set(["road_closure", "lane_closure"]);
const CRITICAL_SEVERITY = "critical";

/**
 * Maximum spacing (metres) between consecutive exclusion points on a densified
 * closure line. Keeps the gap small enough that Valhalla blocks the full segment
 * rather than routing through the space between sparse vertices.
 */
const MAX_EXCLUSION_SPACING_M = 45;

/**
 * Hard cap on exclusion points emitted per single closure geometry. Prevents a
 * single very-long LineString from flooding the Valhalla request body.
 */
const MAX_EXCLUSION_POINTS_PER_CLOSURE = 300;

/**
 * Hard cap on the TOTAL number of exclusion points across all closures in one
 * request. Valhalla rejects more than 50 `exclude_locations` outright
 * (HTTP 400, "Exceeded max avoid locations: 50"), which would fail the whole
 * route — so we stay safely below that ceiling and subsample if needed. 45
 * still blocks a closure densely enough to force a detour (verified against the
 * A565 Bonn-Nord bridge closure).
 */
const MAX_TOTAL_EXCLUSION_POINTS = 45;

/**
 * Evenly subsample `points` down to at most `max`, preserving geographic spread
 * (and the first vertex). Returns the input unchanged when already within `max`.
 */
function subsampleEvenly(points: LngLat[], max: number): LngLat[] {
  if (points.length <= max) return points;
  const stride = points.length / max;
  const out: LngLat[] = [];
  for (let i = 0; i < max; i++) out.push(points[Math.floor(i * stride)] as LngLat);
  return out;
}

function isClosure(type: string, severity: string): boolean {
  // The severity branch is defensive: some providers may not filter by `types`
  // and instead return critical-severity events of any type (e.g. "accident"),
  // so we treat those as blockages too rather than silently ignoring them.
  return CLOSURE_TYPES.has(type) || severity === CRITICAL_SEVERITY;
}

/**
 * Whether a crowd-origin event must be withheld from routing. A user-reported
 * closure becomes a Valhalla exclusion ONLY once it is `routingEligible` (an
 * external resolution corroborated it — peer votes never do). This mirrors the
 * OpenConditions export gate (`eventsToExclusions`) exactly.
 *
 * The gate is DELIBERATELY asymmetric: the ONLY thing it can drop is an
 * explicit `originKind === "crowd"` event that is not routing-eligible. A `feed`
 * event, or one with NO `originKind` at all, always keeps routing — this path
 * aggregates many providers (TomTom/HERE/DATEX feeds) that never stamp
 * `originKind`, and silently dropping their closures would route a car into a
 * real closed road (a worse hazard than surfacing an over-eager crowd report).
 * The burden is on the crowd provider to stamp `originKind === "crowd"`, which
 * the OpenConditions provider does, so the crowd-drop fires correctly while
 * official events are never regressed.
 */
function isCrowdNonRoutable(event: { originKind?: string; routingEligible?: boolean }): boolean {
  return event.originKind === "crowd" && event.routingEligible !== true;
}

function parseHhMm(s: string | undefined): number | null {
  if (!s) return null;
  const m = s.match(/^(\d{1,2}):(\d{2})/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

const ICAL_DAY = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

/** iCal weekday code for a local "YYYY-MM-DD" date (UTC-parsed → calendar day). */
function iCalDayOf(localDate: string): string | undefined {
  const d = new Date(`${localDate}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? undefined : ICAL_DAY[d.getUTCDay()];
}

function addDaysLocal(localDate: string, delta: number): string {
  const d = new Date(`${localDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

/** ISO-8601 duration → milliseconds (PnDTnHnMnS subset). */
function durationToMs(iso: string | undefined): number | null {
  if (!iso) return null;
  const m = iso.match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if (!m) return null;
  const [, d, h, mi, s] = m;
  return (
    (Number(d ?? 0) * 86_400 + Number(h ?? 0) * 3_600 + Number(mi ?? 0) * 60 + Number(s ?? 0)) *
    1_000
  );
}

/** Length of each occurrence: explicit `duration`, else endTime−startTime
 * (overnight-aware), else the whole day. */
function occurrenceDurationMs(schedule: RoadConditionSchedule): number {
  const explicit = durationToMs(schedule.duration);
  if (explicit != null) return explicit;
  const s = parseHhMm(schedule.startTime);
  const e = parseHhMm(schedule.endTime);
  if (s != null && e != null) {
    let mins = e - s;
    if (mins <= 0) mins += 24 * 60;
    return mins * 60_000;
  }
  return 24 * 3_600 * 1_000;
}

/** Whether the recurrence has an occurrence STARTING on local date `d`. */
function occurrenceStartsOn(schedule: RoadConditionSchedule, d: string): boolean {
  if (schedule.startDate && d < schedule.startDate.slice(0, 10)) return false;
  if (schedule.endDate && d > schedule.endDate.slice(0, 10)) return false;
  if (schedule.exceptDate?.some((x) => x.slice(0, 10) === d)) return false;
  if (schedule.byDay && schedule.byDay.length > 0) {
    const ical = iCalDayOf(d);
    if (!ical || !schedule.byDay.includes(ical)) return false;
  }
  return true;
}

/**
 * Whether the instant `at` falls inside an occurrence of a schema.org-shaped
 * `Schedule`, evaluated in the schedule's OWN `scheduleTimezone` (DST-correct).
 * Each occurrence starts at `startTime` (local) on a qualifying date and lasts
 * `occurrenceDurationMs`. We test the occurrence that could contain `at` — one
 * starting on `at`'s local date, or the previous local date for a window that
 * runs past midnight.
 */
function occursAt(schedule: RoadConditionSchedule, at: Date): boolean {
  const tz = schedule.scheduleTimezone;
  if (!tz) return true; // zone-less schedule can't be evaluated → don't suppress
  const startTime = schedule.startTime ?? "00:00";
  const durMs = occurrenceDurationMs(schedule);
  const atLocalDate = localDateInZone(at, tz);
  for (const startDate of [atLocalDate, addDaysLocal(atLocalDate, -1)]) {
    if (!occurrenceStartsOn(schedule, startDate)) continue;
    const start = zonedWallClockToInstant(tz, `${startDate}T${startTime}`);
    if (!start) continue;
    const startMs = start.getTime();
    if (at.getTime() >= startMs && at.getTime() < startMs + durMs) return true;
  }
  return false;
}

/**
 * Whether a closure is in effect at the requested travel time `at`. Many feeds
 * publish planned closures days ahead, and some (e.g. nightly roadworks) are
 * active only inside recurring windows; without this check the router would
 * detour around a closure that hasn't started, has ended, or is only active at
 * night. `at` is the chosen departure/arrival instant, or "now" for an immediate
 * trip. A closure with no temporal info is treated as ongoing (always in effect).
 *
 * A `schedule` is the precise definition of when the closure is in effect and
 * supersedes the coarse `validFrom`/`validTo` span (just the outer bounds). It
 * is evaluated in its own `scheduleTimezone`, so the result is DST-correct and
 * independent of the server's or the route origin's zone.
 */
function isActiveAt(
  event: {
    validFrom?: string | null;
    validTo?: string | null;
    schedule?: RoadConditionSchedule[];
  },
  at: Date,
): boolean {
  const t = at.getTime();
  if (Number.isNaN(t)) return true; // unparseable travel time → don't suppress
  if (event.schedule && event.schedule.length > 0) {
    return event.schedule.some((s) => occursAt(s, at));
  }
  if (event.validFrom) {
    const from = Date.parse(event.validFrom);
    if (!Number.isNaN(from) && t < from) return false; // not yet in effect at travel time
  }
  if (event.validTo) {
    const to = Date.parse(event.validTo);
    if (!Number.isNaN(to) && t > to) return false; // already ended by travel time
  }
  return true;
}

function toLngLat(coord: number[]): LngLat | null {
  if (coord.length < 2) return null;
  const [lng, lat] = coord;
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
  return [lng as number, lat as number];
}

/**
 * Densify a single line segment from `a` to `b` by inserting interpolated
 * [lng,lat] points whenever the segment exceeds MAX_EXCLUSION_SPACING_M. The
 * start vertex `a` is included; the end vertex `b` is NOT (the caller appends
 * it after the final segment to avoid duplicates).
 */
function densifySegment(a: LngLat, b: LngLat): LngLat[] {
  const dist = haversineDistance(a, b);
  const steps = Math.ceil(dist / MAX_EXCLUSION_SPACING_M);
  if (steps <= 1) return [a];
  const result: LngLat[] = [];
  for (let i = 0; i < steps; i++) {
    const t = i / steps;
    result.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
  }
  return result;
}

/**
 * Convert a LineString coordinate array into a densified set of [lng,lat]
 * exclusion points, capped at MAX_EXCLUSION_POINTS_PER_CLOSURE.
 */
function densifyLine(coords: number[][], ctx: IntegrationContext): LngLat[] {
  const vertices: LngLat[] = [];
  for (const c of coords) {
    const p = toLngLat(c);
    if (p) vertices.push(p);
  }
  if (vertices.length === 0) return [];
  if (vertices.length === 1) return [vertices[0] as LngLat];

  const out: LngLat[] = [];
  for (let i = 0; i < vertices.length - 1; i++) {
    const seg = densifySegment(vertices[i] as LngLat, vertices[i + 1] as LngLat);
    for (const pt of seg) {
      out.push(pt);
      if (out.length >= MAX_EXCLUSION_POINTS_PER_CLOSURE) {
        ctx.log.warn(
          `[routing/closures] closure line exceeded ${MAX_EXCLUSION_POINTS_PER_CLOSURE} exclusion points; trimming`,
        );
        return out;
      }
    }
  }
  const last = vertices[vertices.length - 1] as LngLat;
  if (out.length < MAX_EXCLUSION_POINTS_PER_CLOSURE) {
    out.push(last);
  } else {
    ctx.log.warn(
      `[routing/closures] closure line exceeded ${MAX_EXCLUSION_POINTS_PER_CLOSURE} exclusion points; trimming`,
    );
  }
  return out;
}

function sampleCoords(coords: number[][]): LngLat[] {
  const out: LngLat[] = [];
  for (const c of coords) {
    const p = toLngLat(c);
    if (p) out.push(p);
  }
  return out;
}

function geometryToExclusions(
  geometry: { type: string; coordinates?: unknown },
  points: LngLat[],
  polygons: LngLat[][],
  ctx: IntegrationContext,
): void {
  switch (geometry.type) {
    case "Point": {
      const p = toLngLat(geometry.coordinates as number[]);
      if (p) points.push(p);
      break;
    }
    case "LineString": {
      points.push(...densifyLine(geometry.coordinates as number[][], ctx));
      break;
    }
    case "MultiLineString": {
      for (const line of geometry.coordinates as number[][][]) {
        points.push(...densifyLine(line, ctx));
      }
      break;
    }
    case "Polygon": {
      const ring = (geometry.coordinates as number[][][])[0] ?? [];
      const outer = sampleCoords(ring);
      if (outer.length >= 3) polygons.push(outer);
      break;
    }
    case "MultiPolygon": {
      for (const poly of geometry.coordinates as number[][][][]) {
        const outer = sampleCoords(poly[0] ?? []);
        if (outer.length >= 3) polygons.push(outer);
      }
      break;
    }
    case "MultiPoint": {
      // Push each point as its own exclusion — do NOT collapse to a centroid,
      // which can sit off-road between the two ends of a "between X and Y"
      // closure (the shape DATEX2 feeds emit for this case).
      for (const c of geometry.coordinates as number[][]) {
        const p = toLngLat(c);
        if (p) points.push(p);
      }
      break;
    }
    case "GeometryCollection": {
      const geometries =
        (geometry as { geometries?: Array<{ type: string; coordinates?: unknown }> }).geometries ??
        [];
      for (const g of geometries) {
        geometryToExclusions(g, points, polygons, ctx);
      }
      break;
    }
    default:
      break;
  }
}

/**
 * Collect active road closures from all registered road-conditions providers
 * and convert them into Valhalla-compatible exclusion geometry.
 *
 * The routing integration depends only on the `road-conditions` capability
 * contract — never on `@openconditions/*` packages or the conditions.observations
 * table directly.
 */
export async function activeClosuresForBbox(
  ctx: IntegrationContext,
  bbox: BBox,
  at?: Date,
): Promise<ClosureExclusions> {
  const refTime = at ?? new Date();
  const integrations = ctx.getIntegrationsByDomain("road-conditions");
  if (integrations.length === 0) return { points: [], polygons: [] };

  const providers = integrations.flatMap(
    (i) => (i.providers.get("road-conditions") ?? []) as RoadConditionsProvider[],
  );
  if (providers.length === 0) return { points: [], polygons: [] };

  // No `minSeverity` floor: road/lane closures are route-blocking regardless
  // of severity (e.g. OC derives an undeclared-severity lane_closure as
  // "medium"), so pre-filtering by severity here would drop real closures
  // before isClosure() ever sees them. isClosure() remains the sole gate.
  const settled = await Promise.allSettled(
    providers.map((p) =>
      p.getEvents(bbox, {
        types: ["road_closure", "lane_closure"],
      }),
    ),
  );

  const disallowed = (await ctx.getDisallowedSourceIds?.()) ?? new Set<string>();

  const points: LngLat[] = [];
  const polygons: LngLat[][] = [];

  for (let i = 0; i < settled.length; i++) {
    const result = settled[i];
    if (!result) continue;
    if (result.status === "rejected") {
      ctx.log.warn(
        `[routing/closures] road-conditions provider ${providers[i]?.id} failed`,
        result.reason,
      );
      continue;
    }
    for (const event of result.value) {
      if (disallowed.has(event.source)) continue;
      // Withhold an unconfirmed crowd report from routing (fail-open on unknown
      // origin — feed/undefined always route). See isCrowdNonRoutable.
      if (isCrowdNonRoutable(event)) continue;
      if (!isClosure(event.type, event.severity)) continue;
      if (event.roadState === "open") continue;
      if (!isActiveAt(event, refTime)) continue;
      if (!event.geometry) continue;
      geometryToExclusions(event.geometry, points, polygons, ctx);
    }
  }

  if (points.length > MAX_TOTAL_EXCLUSION_POINTS) {
    const trimmed = subsampleEvenly(points, MAX_TOTAL_EXCLUSION_POINTS);
    ctx.log.warn(
      `[routing/closures] ${points.length} exclusion points exceed Valhalla's exclude_locations limit; subsampled to ${trimmed.length}`,
    );
    return { points: trimmed, polygons };
  }

  return { points, polygons };
}
