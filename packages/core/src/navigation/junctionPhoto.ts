import type { LngLat } from "../types/geometry";
import type { JunctionDecisionPoint, JunctionWay } from "../types/junction";
import type { StreetLevelImage } from "../types/streetLevel";
import { haversineDistance } from "../utils/coordinates";
import { angularDifference, bearingBetween } from "./bearing";
import { cumulativeDistances } from "./deadReckon";
import { photoApproachEvidence } from "./photoApproach";
import { approachCamera } from "./photoProjection";

/**
 * Photo selection for the junction photo preview. Pure arithmetic over
 * already-fetched imagery — nothing here runs per fix. The route path drawn
 * on the chosen photo is projected in `photoProjection.ts`.
 */

const DEFAULT_MAX_AGE_YEARS = 8;
/** Heading window around the approach bearing, degrees. */
const HEADING_TOLERANCE_DEG = 30;
/**
 * Distance window between the camera and the decision point, metres. Frames
 * further out show plain motorway before the exit lane opens; around 80 m the
 * exit lane and the overhead boards are both in view.
 */
const MIN_DISTANCE_METERS = 30;
const MAX_DISTANCE_METERS = 200;
const TARGET_DISTANCE_METERS = 80;
/** Upstream-position tolerance: the bearing from the image to the point. */
const UPSTREAM_TOLERANCE_DEG = 45;

/** Photo-selection options; the age limit guards against stale imagery. */
export interface SelectJunctionPhotoOptions {
  maxAgeYears?: number;
  /** Road-level evidence for the actual approach; unknown image level cannot corroborate a tunnel. */
  approachWay?: JunctionWay;
  approachWays?: JunctionWay[];
  /**
   * The route being driven. With it, each photo's heading is judged against
   * the road where the photo was taken rather than against the approach
   * bearing read 100 m before the split — the two differ on a curve — and a
   * photo off the route is rejected outright.
   */
  geometry?: LngLat[];
  /**
   * Metres before the split from which the exit lanes already exist (from
   * OSM). A frame inside that stretch shows every lane the driver picks from;
   * one further back catches the lane still opening, or not there yet.
   */
  fullLanesFromMeters?: number;
}

/**
 * Pick the photo for a decision point: recent enough, heading within ±30° of
 * the approach, 30–200 m upstream of it. The newest capture month wins; within
 * a month (one drive captures a frame every few metres) a frame where the exit
 * lanes already exist beats one before, and then the frame closest to 80 m
 * wins — or closest to where those lanes begin, when that is nearer the split.
 * `null` when nothing qualifies — destination signs remain alone.
 */
export function rankJunctionPhotos(
  images: StreetLevelImage[],
  point: JunctionDecisionPoint,
  now: Date,
  opts: SelectJunctionPhotoOptions = {},
): StreetLevelImage[] {
  if (opts.approachWay?.tunnel || (opts.approachWay?.layer ?? 0) < 0) return [];
  const maxAgeMs = (opts.maxAgeYears ?? DEFAULT_MAX_AGE_YEARS) * 365.25 * 24 * 3600 * 1000;
  const geometry = opts.geometry && opts.geometry.length >= 2 ? opts.geometry : undefined;
  const cum = geometry ? cumulativeDistances(geometry) : undefined;
  const fullLanesFrom = opts.fullLanesFromMeters;
  const target =
    fullLanesFrom === undefined
      ? TARGET_DISTANCE_METERS
      : Math.min(TARGET_DISTANCE_METERS, fullLanesFrom);
  const candidates = images.flatMap((image) => {
    if (image.heading === undefined) return [];
    if (opts.approachWays && geometry) {
      const evidence = photoApproachEvidence(geometry, point, image, opts.approachWays);
      if (evidence.state !== "known" || evidence.way?.tunnel || (evidence.way?.layer ?? 0) < 0)
        return [];
    }
    const camera = geometry && cum ? approachCamera(geometry, cum, point, image.lngLat) : undefined;
    // Off the route (another carriageway, a service road, or past the split):
    // nothing it shows describes this approach.
    if (camera && !camera.onApproach) return [];
    const roadBearing = camera?.bearing ?? point.approachBearing;
    if (!image.isPano && angularDifference(image.heading, roadBearing) > HEADING_TOLERANCE_DEG) {
      return [];
    }
    const distance = camera
      ? point.alongMeters - camera.alongMeters
      : haversineDistance(image.lngLat, point.point);
    if (distance < MIN_DISTANCE_METERS || distance > MAX_DISTANCE_METERS) return [];
    // Without the route, a frame past the exit that happens to face along the
    // road has to be caught by the bearing from the image to the point.
    const towardPoint = bearingBetween(image.lngLat, point.point);
    if (!camera && angularDifference(towardPoint, point.approachBearing) > UPSTREAM_TOLERANCE_DEG) {
      return [];
    }
    if (!image.capturedAt) return [];
    const capturedAt = new Date(image.capturedAt).getTime();
    if (
      !Number.isFinite(capturedAt) ||
      capturedAt > now.getTime() + 86_400_000 ||
      now.getTime() - capturedAt > maxAgeMs
    )
      return [];
    const captured = new Date(capturedAt);
    return [
      {
        image,
        month: captured.getUTCFullYear() * 12 + captured.getUTCMonth(),
        beforeLanes: fullLanesFrom !== undefined && distance > fullLanesFrom ? 1 : 0,
        distanceOffset: Math.abs(distance - target),
      },
    ];
  });
  if (candidates.length === 0) return [];
  candidates.sort(
    (a, b) =>
      a.beforeLanes - b.beforeLanes || b.month - a.month || a.distanceOffset - b.distanceOffset,
  );
  return candidates.map((candidate) => candidate.image);
}

export function selectJunctionPhoto(
  images: StreetLevelImage[],
  point: JunctionDecisionPoint,
  now: Date,
  opts: SelectJunctionPhotoOptions = {},
): StreetLevelImage | null {
  return rankJunctionPhotos(images, point, now, opts)[0] ?? null;
}
