import type { LngLat } from "../types/geometry";
import type { JunctionDecisionPoint, JunctionWay } from "../types/junction";
import type { StreetLevelImage } from "../types/streetLevel";
import { angularDifference, bearingBetween } from "./bearing";
import { cumulativeDistances } from "./deadReckon";
import { approachCamera } from "./photoProjection";
import { prepareRouteMatcher, snapPreparedRoute } from "./routeMatcher";

export interface PhotoApproachEvidence {
  state: "known" | "unknown" | "conflict";
  way?: JunctionWay;
}

/** Match the road interval at the camera, rather than borrowing the layout at the split. */
export function photoApproachEvidence(
  geometry: LngLat[],
  point: JunctionDecisionPoint,
  image: StreetLevelImage,
  ways: JunctionWay[],
): PhotoApproachEvidence {
  if (geometry.length < 2) return { state: "unknown" };
  const camera = approachCamera(geometry, cumulativeDistances(geometry), point, image.lngLat);
  if (!camera.onApproach) return { state: "unknown" };
  const candidates = ways
    .flatMap((way) => {
      if (!way.geometry || way.geometry.length < 2) return [];
      const match = snapPreparedRoute(prepareRouteMatcher(way.geometry), camera.point);
      const actual = snapPreparedRoute(prepareRouteMatcher(way.geometry), image.lngLat);
      const halfWidth = (Math.min(6, Math.max(1, way.tags.lanes ?? 1)) * 3.5) / 2;
      if (
        match.deviationMeters > 5 ||
        angularDifference(
          bearingBetween(
            way.geometry[Math.min(match.segmentIndex, way.geometry.length - 2)],
            way.geometry[Math.min(match.segmentIndex + 1, way.geometry.length - 1)],
          ),
          camera.bearing,
        ) > 35 ||
        actual.deviationMeters > halfWidth + 3
      )
        return [];
      return [{ way, deviation: match.deviationMeters }];
    })
    .sort((a, b) => a.deviation - b.deviation);
  if (!candidates.length) return { state: "unknown" };
  // Adjacent intervals sharing an endpoint may corroborate one another. Different
  // road levels or lane counts at the same camera position must remain ambiguous.
  const close = candidates.filter(
    (candidate) => candidate.deviation <= candidates[0].deviation + 1,
  );
  if (
    close.some(
      ({ way }) =>
        (way.layer ?? 0) !== (close[0].way.layer ?? 0) ||
        !!way.tunnel !== !!close[0].way.tunnel ||
        way.tags.lanes !== close[0].way.tags.lanes,
    )
  )
    return { state: "conflict" };
  return { state: "known", way: candidates[0].way };
}
