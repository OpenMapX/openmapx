import type { JunctionDecisionPoint, JunctionLookupPoint } from "../types/junction";
import type { Route } from "../types/routing";
import { cumulativeDistances, positionAt } from "./deadReckon";

/**
 * The request points sent to `POST /navigation/junctions`, derived purely from
 * the route: each decision point carries route vertices sampled at 400, 250,
 * 120 and 30 m upstream, the point itself and 30 m downstream, so the server
 * searches OSM along the real approach rather than a bearing extrapolation.
 */

/** Upstream offsets (m) the trace samples at, oldest first. */
const TRACE_UPSTREAM_METERS = [400, 250, 120, 30] as const;
/** Downstream offset (m) of the last trace vertex. */
const TRACE_DOWNSTREAM_METERS = 30;

/** One lookup request per decision point, with its step index alongside. */
export function junctionLookupPoints(
  route: Route,
  decisionPoints: JunctionDecisionPoint[],
): { stepIndex: number; lookup: JunctionLookupPoint }[] {
  const cum = cumulativeDistances(route.geometry);
  const total = cum[cum.length - 1];
  const at = (along: number): [number, number] =>
    positionAt(route.geometry, cum, Math.min(Math.max(along, 0), total)).point as [number, number];
  return decisionPoints.map((point) => ({
    stepIndex: point.stepIndex,
    lookup: {
      lng: point.point[0],
      lat: point.point[1],
      bearing: point.approachBearing,
      trace: [
        ...TRACE_UPSTREAM_METERS.map((offset) => at(point.alongMeters - offset)),
        at(point.alongMeters),
        at(point.alongMeters + TRACE_DOWNSTREAM_METERS),
      ],
    },
  }));
}
