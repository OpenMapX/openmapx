import type { LngLat } from "../types/geometry";
import { haversineDistance } from "../utils/coordinates";

/** How close a matched edge must end to the maneuver point to be its approach. */
const APPROACH_END_M = 5;

/**
 * The OSM way the car arrives on at each maneuver (immersive navigation spec
 * §4.2, §9.2): the matched edge whose end lies nearest the maneuver point,
 * within 5 m; on a tie the later one in route order. Nearest rather than last,
 * because an outgoing way split a few metres past the junction also ends
 * within 5 m. Maneuvers without such an edge get no entry, so the lane
 * highlight draws nothing there.
 */
export function approachWayIdsFromWindow(
  maneuverPoints: readonly { stepIndex: number; point: LngLat }[],
  matched: {
    geometry: readonly LngLat[];
    edges: readonly { wayId: number; endShapeIndex: number }[];
  },
): Record<number, number> {
  const ids: Record<number, number> = {};
  for (const { stepIndex, point } of maneuverPoints) {
    let nearest = APPROACH_END_M;
    for (const edge of matched.edges) {
      const end = matched.geometry[edge.endShapeIndex];
      if (!end) continue;
      const distance = haversineDistance(end, point);
      if (distance <= nearest) {
        nearest = distance;
        ids[stepIndex] = edge.wayId;
      }
    }
  }
  return ids;
}
