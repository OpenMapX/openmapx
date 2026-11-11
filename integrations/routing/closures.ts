import type {
  BBox,
  LngLat,
  RoadConditionEffect,
  RoadConditionEvent,
  RoadConditionRouteImpact,
  TravelMode,
} from "@openmapx/core";
import { closesRoadForCars, isLocalAccessClosure } from "@openmapx/core";
import type { IntegrationContext, RoadConditionsProvider } from "@openmapx/integration-framework";
import { assessRoadConditionForRoute } from "./road-condition-routing.js";
import { rightsPolicyOf } from "./traffic-application.js";

export interface ClosureExclusions {
  points: LngLat[];
  polygons: LngLat[][];
  roadConditionImpact: RoadConditionRouteImpact;
  /** Lines of the roads the engine's live traffic closes to all but local access. */
  localAccessLines: LngLat[][];
  /** Lines of the closures no car may use. */
  hardLines: LngLat[][];
}

/** The lines a closure geometry lies along; a point is a line of one vertex, a polygon its outer ring. */
function geometryLines(geometry: { type: string; coordinates?: unknown }): LngLat[][] {
  const line = (coords: number[][]) => sampleCoords(coords);
  switch (geometry.type) {
    case "Point": {
      const p = toLngLat(geometry.coordinates as number[]);
      return p ? [[p]] : [];
    }
    case "MultiPoint":
      return (geometry.coordinates as number[][]).flatMap((c) => {
        const p = toLngLat(c);
        return p ? [[p]] : [];
      });
    case "LineString":
      return [line(geometry.coordinates as number[][])];
    case "MultiLineString":
      return (geometry.coordinates as number[][][]).map(line);
    case "Polygon":
      return [line((geometry.coordinates as number[][][])[0] ?? [])];
    case "MultiPolygon":
      return (geometry.coordinates as number[][][][]).map((poly) => line(poly[0] ?? []));
    case "GeometryCollection":
      return (
        (geometry as { geometries?: Array<{ type: string; coordinates?: unknown }> }).geometries ??
        []
      ).flatMap(geometryLines);
    default:
      return [];
  }
}

/** The place an effect closes: its own location when it has one, else its situation's. */
function effectGeometry(
  event: RoadConditionEvent,
  effect: RoadConditionEffect,
): { type: string; coordinates?: unknown } | undefined {
  const own = effect.location?.geometry as { type?: unknown } | null | undefined;
  if (own && typeof own === "object" && typeof own.type === "string") {
    return own as { type: string; coordinates?: unknown };
  }
  return event.geometry ?? undefined;
}

function toLngLat(coord: number[]): LngLat | null {
  if (coord.length < 2) return null;
  const [lng, lat] = coord;
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
  return [lng as number, lat as number];
}

function sampleCoords(coords: number[][]): LngLat[] {
  const out: LngLat[] = [];
  for (const c of coords) {
    const p = toLngLat(c);
    if (p) out.push(p);
  }
  return out;
}

/**
 * Collect the effects that close a road to cars at the travel time from all
 * registered road-conditions providers and return the lines of those the
 * engine's shared live traffic closes, with the availability of road-condition
 * data for the route. Raw event geometry never becomes a route exclusion; an
 * effect without graph routing evidence binds nothing.
 *
 * Each effect of a situation is judged on its own: a situation can close one
 * carriageway, cap the speed on another and restrict lorries on a third.
 *
 * The routing integration depends only on the `road-conditions` capability
 * contract — never on `@openconditions/*` packages directly.
 */
export async function activeClosuresForBbox(
  ctx: IntegrationContext,
  bbox: BBox,
  at?: Date,
  mode: TravelMode = "driving",
): Promise<ClosureExclusions> {
  const refTime = at ?? new Date();
  const evaluatedAt = new Date();
  const unavailable = (reason: string): ClosureExclusions => ({
    points: [],
    polygons: [],
    localAccessLines: [],
    hardLines: [],
    roadConditionImpact: {
      availability: "unavailable",
      evaluatedAt: evaluatedAt.toISOString(),
      validUntil: null,
      reasons: [reason],
    },
  });
  const integrations = ctx.getIntegrationsByDomain("road-conditions");
  if (integrations.length === 0) return unavailable("no_road_condition_provider");

  const providers = integrations.flatMap(
    (i) => (i.providers.get("road-conditions") ?? []) as RoadConditionsProvider[],
  );
  if (providers.length === 0) return unavailable("no_road_condition_provider");

  // Load every kind: graph-bound speed caps also need application
  // assessment.
  const settled = await Promise.allSettled(providers.map((p) => p.getEvents(bbox, {})));

  const disallowed = (await ctx.getDisallowedSourceIds?.()) ?? new Set<string>();
  // Only an authoritative policy may admit unclear or non-commercial rights.
  const policy = await ctx.getRoadConditionsPolicySnapshot?.().catch(() => undefined);
  const rightsPolicy = rightsPolicyOf(policy?.authoritative ? policy : undefined);
  const localAccessLines: LngLat[][] = [];
  const hardLines: LngLat[][] = [];
  let sawRoutingEvidence = false;
  let providerFailed = false;
  const assessmentReasons = new Set<string>();
  const deadlines: number[] = [];

  for (let i = 0; i < settled.length; i++) {
    const result = settled[i];
    if (!result) continue;
    if (result.status === "rejected") {
      providerFailed = true;
      ctx.log.warn(
        `[routing/closures] road-conditions provider ${providers[i]?.id} failed`,
        result.reason,
      );
      continue;
    }
    for (const event of result.value) {
      if (disallowed.has(event.source)) continue;
      if (event.routingEvidence) sawRoutingEvidence = true;
      for (const effect of event.effects ?? []) {
        const routeDecision = assessRoadConditionForRoute(event, effect, {
          evaluatedAt: evaluatedAt.getTime(),
          travelAt: refTime.getTime(),
          mode,
          // This planning stage runs before any engine request. Request-bound
          // application is assessed against the actual returned route later.
          sharedTrafficApplied: false,
          disallowedSources: disallowed,
          rightsPolicy,
        });
        for (const reason of routeDecision.reasons) assessmentReasons.add(reason);
        if (routeDecision.validUntil) {
          const deadline = Date.parse(routeDecision.validUntil);
          if (Number.isFinite(deadline)) deadlines.push(deadline);
        }
        // A closure in the shared live traffic closes the road in the
        // engine; its line decides how the route's ends are relaxed.
        if (
          closesRoadForCars(effect) &&
          assessRoadConditionForRoute(event, effect, {
            evaluatedAt: evaluatedAt.getTime(),
            travelAt: refTime.getTime(),
            mode,
            sharedTrafficApplied: true,
            disallowedSources: disallowed,
            rightsPolicy,
          }).disposition === "shared-traffic"
        ) {
          const geometry = effectGeometry(event, effect);
          if (geometry) {
            (isLocalAccessClosure(effect) ? localAccessLines : hardLines).push(
              ...geometryLines(geometry),
            );
          }
        }
      }
    }
  }

  const validUntil = deadlines.length ? new Date(Math.min(...deadlines)).toISOString() : null;
  const availability: RoadConditionRouteImpact["availability"] = sawRoutingEvidence
    ? "unsupported"
    : "unavailable";
  if (!sawRoutingEvidence) {
    assessmentReasons.add(
      providerFailed ? "road_condition_provider_unavailable" : "missing_current_evidence",
    );
  }
  return {
    points: [],
    polygons: [],
    localAccessLines,
    hardLines,
    roadConditionImpact: {
      availability,
      evaluatedAt: evaluatedAt.toISOString(),
      validUntil,
      reasons: [...assessmentReasons],
    },
  };
}
