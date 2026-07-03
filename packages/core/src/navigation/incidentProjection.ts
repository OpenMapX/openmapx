import type { LngLat } from "../types/geometry";
import type {
  RoadConditionEvent,
  RoadConditionSeverity,
  RoadConditionType,
} from "../types/roadConditions";
import type { RoadAlert } from "./alerts";
import { snapToRoute } from "./snap";

/** A road-condition event projected onto the active route as an approach alert. */
export interface IncidentAlert extends RoadAlert {
  type: "traffic_incident";
  eventType: RoadConditionType;
  severity: RoadConditionSeverity;
  headline: string;
  approach: { leadSec: number; minM: number; maxM: number };
}

/** Severity-scaled approach windows: critical incidents announce earlier/farther. */
const SEVERITY_APPROACH: Record<
  RoadConditionSeverity,
  { leadSec: number; minM: number; maxM: number }
> = {
  critical: { leadSec: 30, minM: 600, maxM: 2500 },
  high: { leadSec: 20, minM: 400, maxM: 1500 },
  medium: { leadSec: 14, minM: 250, maxM: 1000 },
  low: { leadSec: 10, minM: 150, maxM: 600 },
  unknown: { leadSec: 12, minM: 200, maxM: 800 },
};

export interface ProjectEventsOptions {
  corridorMeters?: number;
  lookaheadMeters?: number;
}

const DEFAULT_CORRIDOR_M = 1200;
const DEFAULT_LOOKAHEAD_M = 25_000;

/** Every [lon,lat] position in a GeoJSON geometry (incl. GeometryCollection). */
function flattenPositions(geometry: RoadConditionEvent["geometry"]): LngLat[] {
  const out: LngLat[] = [];
  const walk = (c: unknown): void => {
    if (!Array.isArray(c)) return;
    if (typeof c[0] === "number" && typeof c[1] === "number") {
      out.push([c[0], c[1]]);
      return;
    }
    for (const x of c) walk(x);
  };
  const g = geometry as { type?: string; coordinates?: unknown; geometries?: unknown[] };
  if (g.type === "GeometryCollection" && Array.isArray(g.geometries)) {
    for (const sub of g.geometries)
      out.push(...flattenPositions(sub as RoadConditionEvent["geometry"]));
  } else {
    walk(g.coordinates);
  }
  return out;
}

/**
 * Point → its coordinate; line/polygon → the vertex nearest the route (so the
 * snapped along-distance is where the driver reaches the incident).
 */
function representativePoint(
  geometry: RoadConditionEvent["geometry"],
  routeGeometry: LngLat[],
): LngLat | null {
  const positions = flattenPositions(geometry);
  if (positions.length === 0) return null;
  if (positions.length === 1) return positions[0]!;
  let best = positions[0]!;
  let bestDev = Number.POSITIVE_INFINITY;
  for (const p of positions) {
    const dev = snapToRoute(routeGeometry, p).deviationMeters;
    if (dev < bestDev) {
      bestDev = dev;
      best = p;
    }
  }
  return best;
}

/**
 * Project road-condition events onto the active route and keep those ahead of
 * the current position and within the corridor + look-ahead window, as
 * severity-scaled `IncidentAlert`s ready for {@link selectActiveAlert}. Pure;
 * sorted by along-distance.
 */
export function projectEventsToRoute(
  events: RoadConditionEvent[],
  routeGeometry: LngLat[],
  currentAlongMeters: number,
  opts: ProjectEventsOptions = {},
): IncidentAlert[] {
  if (routeGeometry.length < 2) return [];
  const corridor = opts.corridorMeters ?? DEFAULT_CORRIDOR_M;
  const lookahead = opts.lookaheadMeters ?? DEFAULT_LOOKAHEAD_M;

  const out: IncidentAlert[] = [];
  for (const ev of events) {
    const rep = representativePoint(ev.geometry, routeGeometry);
    if (!rep) continue;
    const snap = snapToRoute(routeGeometry, rep);
    if (snap.deviationMeters > corridor) continue;
    const ahead = snap.alongMeters - currentAlongMeters;
    if (ahead <= 0 || ahead > lookahead) continue;
    out.push({
      id: ev.id,
      type: "traffic_incident",
      coord: rep,
      alongMeters: snap.alongMeters,
      eventType: ev.type,
      severity: ev.severity,
      headline: ev.headline,
      approach: SEVERITY_APPROACH[ev.severity] ?? SEVERITY_APPROACH.unknown,
    });
  }
  out.sort((a, b) => a.alongMeters - b.alongMeters);
  return out;
}
