import type { LngLat } from "../types/geometry";
import type { JunctionDecisionPoint } from "../types/junction";
import type { StreetLevelImage } from "../types/streetLevel";
import { haversineDistance } from "../utils/coordinates";
import { angularDifference, bearingBetween } from "./bearing";
import { cumulativeDistances, positionAt } from "./deadReckon";

/**
 * Projection of the route ahead onto a street-level photo taken on the
 * approach. Pure geometry: the photo is snapped onto the route (so its own
 * GPS scatter never moves the path sideways), the camera is assumed to face
 * along the road, and the route is projected through a pinhole camera.
 *
 * Coordinates come back as percentages of the *source image*, not of the box
 * it is displayed in, so the overlay can be cropped exactly like the image.
 */

/** Eye height of a dash-mounted camera above the road, metres. */
const CAMERA_HEIGHT_M = 1.3;
/**
 * Half the drawn path, metres — about a car's track width. Narrower than the
 * 3.5 m lane it runs in, so the lane markings either side stay visible.
 */
const PATH_HALF_WIDTH_M = 0.8;
/** Frame shape assumed when the provider reports none; phone cameras shoot 4:3. */
const DEFAULT_ASPECT_RATIO = 4 / 3;
/** Height of the horizon in the frame, percent — a level camera looks straight ahead. */
const HORIZON_PERCENT = 50;
/** The panorama crop window showing the approach, degrees. */
const PANO_CROP_SPAN_DEG = 90;
/** Equirectangular images span the full sphere. */
const PANO_WIDTH_DEG = 360;
const PANO_HEIGHT_DEG = 180;
/** Spacing of the projected samples along the route, metres. */
const SAMPLE_STEP_METERS = 5;
/**
 * Where the path starts at the earliest, metres ahead. Close enough that it
 * runs off the bottom of a typical frame, so it reads as the road under the
 * car rather than a shape floating in the middle of the picture; a lens that
 * sees less of the road starts it at its own bottom edge instead.
 */
const NEAR_CLIP_METERS = 4;
/** How far past the decision point the path follows the ramp, metres. */
const PAST_POINT_METERS = 60;
/** Beyond this the path is a pixel-wide smudge on the horizon, metres. */
const MAX_PATH_METERS = 200;
/** A photo further than this from the route is on another road or carriageway. */
const MAX_CAMERA_OFFSET_METERS = 25;
/**
 * How far upstream of the decision point the photo is looked for. The selector
 * only keeps frames within 200 m, and searching a window rather than the whole
 * route keeps the cost off the route length — and stops a route that passes
 * the same motorway twice from matching the wrong stretch.
 */
const UPSTREAM_SEARCH_METERS = 260;
/** Resolution of that search, metres. */
const SEARCH_STEP_METERS = 1;
/** The camera must look along the road for the forward-facing assumption to hold. */
const MAX_HEADING_MISMATCH_DEG = 40;
/** Lane width used to place the exit lane across the carriageway, metres. */
const LANE_WIDTH_M = 3.5;
/** The path runs straight ahead for this long before it starts moving over, metres. */
const LANE_CHANGE_LEAD_METERS = 10;
/** The move into the exit lane is complete this far before the split, metres. */
const LANE_CHANGE_SETTLE_METERS = 20;
/**
 * How far past the split the path hands over from the exit lane to the ramp's
 * own line. OSM joins a ramp to the carriageway's centre node, so the ramp's
 * first metres run through the through-lanes before it separates.
 */
const RAMP_HANDOVER_METERS = 40;
const METERS_PER_DEGREE = 111_320;
/** Keep the outermost degree clear so a sample never lands exactly on the frame edge. */
const FRAME_EDGE_MARGIN_DEG = 0.5;
/** The path's first sample sits this far inside the bottom edge, so rounding never drops it. */
const BOTTOM_EDGE_MARGIN_DEG = 0.01;

/** One projected route sample, in percent of the source image. */
export interface PhotoPathPoint {
  xPercent: number;
  yPercent: number;
  /** Width of the drawn path at this sample, percent of the image width. */
  widthPercent: number;
  /** Distance from the camera to this sample, metres. */
  distanceMeters: number;
}

/** The slice of a panorama that shows the approach. */
export interface PhotoCropWindow {
  startDeg: number;
  spanDeg: number;
}

export interface PhotoRoutePath {
  /** Camera-first samples of the route ahead; empty when nothing can be drawn. */
  points: PhotoPathPoint[];
  /** How far the route has turned by the end of the path, signed degrees. */
  headRotateDeg: number;
  /** Present for panoramas: the window the image is cropped to. */
  crop?: PhotoCropWindow;
  /**
   * How far the path moves across the carriageway between the camera and the
   * split, metres, positive to the right. 0 when the lane layout is unknown.
   */
  laneShiftMeters: number;
  visible: boolean;
}

export interface PhotoProjectionOptions {
  /** Camera height above the road, metres. */
  cameraHeightM?: number;
  /**
   * Width / height of the source image, measured from the rendered frame.
   * Wins over `image.aspectRatio`, which is only what the provider claims.
   */
  aspectRatio?: number;
  /**
   * The lanes at the split and the ones the exit leaves from (0 = leftmost),
   * from the gantry. With them the path moves from the camera's own lane into
   * the exit lane; without them it follows the route's centreline.
   */
  exitLanes?: { laneCount: number; activeLanes: number[] };
}

/**
 * Project the route from the photo's position through the decision point onto
 * the image. Returns an empty, invisible path when the photo cannot be trusted
 * to show the approach: taken off the route, facing away from it, already
 * past the junction, or through a lens whose field of view is unknown.
 */
export function projectRoutePath(
  geometry: LngLat[],
  point: JunctionDecisionPoint,
  image: StreetLevelImage,
  options: PhotoProjectionOptions = {},
): PhotoRoutePath {
  const crop = image.isPano ? cropWindow(point.approachBearing) : undefined;
  if (geometry.length < 2) return hidden(crop);

  const cum = cumulativeDistances(geometry);
  const camera = approachCamera(geometry, cum, point, image.lngLat);
  // A dash camera points where the car drives, so the route's own bearing is a
  // steadier optical axis than the photo's compass reading. The heading is
  // still checked below, to catch a frame that does not look along the road.
  const axisBearing = camera.bearing;
  const panoCrop = image.isPano ? cropWindow(axisBearing) : undefined;
  if (!camera.onApproach) return hidden(panoCrop);
  if (
    image.heading !== undefined &&
    angularDifference(image.heading, axisBearing) > MAX_HEADING_MISMATCH_DEG
  ) {
    return hidden(panoCrop);
  }

  // Without the lens's field of view the path could land anywhere across a
  // wide-angle frame; showing the photo alone beats a line off the road.
  if (!image.isPano && image.fovDeg === undefined) return hidden();
  // An equirectangular frame is centred on the photo's heading, not on the
  // road: a panorama's horizontal position is read against that, and without
  // it there is nothing to place the path against.
  if (image.isPano && image.heading === undefined) return hidden(panoCrop);
  const panoCentreBearing = image.heading ?? axisBearing;
  const halfWidthDeg = image.isPano ? PANO_WIDTH_DEG / 2 : Math.max((image.fovDeg ?? 0) / 2, 1);
  const aspectRatio = options.aspectRatio ?? image.aspectRatio ?? DEFAULT_ASPECT_RATIO;
  const halfHeightDeg = image.isPano
    ? PANO_HEIGHT_DEG / 2
    : toDegrees(Math.atan(Math.tan(toRadians(halfWidthDeg)) / aspectRatio));
  const cameraHeight = options.cameraHeightM ?? CAMERA_HEIGHT_M;

  // The path starts where the road enters the bottom of the frame. A narrow
  // or wide-format lens sees the road only from further out than the near
  // clip, and a path started below the frame would be cut off at its first
  // sample.
  const bottomEdgeMeters = image.isPano
    ? 0
    : cameraHeight / Math.tan(toRadians(halfHeightDeg - BOTTOM_EDGE_MARGIN_DEG));
  const startAlong = camera.alongMeters + Math.max(NEAR_CLIP_METERS, bottomEdgeMeters);
  if (point.alongMeters <= startAlong) return hidden(panoCrop);
  const endAlong = Math.min(
    point.alongMeters + PAST_POINT_METERS,
    camera.alongMeters + MAX_PATH_METERS,
    cum[cum.length - 1],
  );

  // Lateral offsets are metres right of the route line, which follows the
  // carriageway's centre. The exit lane is placed from the gantry; the camera
  // from its own GPS — only its lateral offset, clamped to the carriageway's
  // outer lanes, since that is all the lane change needs from it.
  const exitOffset = exitLaneOffset(options.exitLanes);
  const outerLaneOffset = options.exitLanes
    ? ((options.exitLanes.laneCount - 1) * LANE_WIDTH_M) / 2
    : 0;
  const cameraOffset =
    exitOffset === undefined
      ? 0
      : Math.min(Math.max(camera.lateralOffsetMeters, -outerLaneOffset), outerLaneOffset);
  const shiftStart = camera.alongMeters + LANE_CHANGE_LEAD_METERS;
  const shiftEnd = Math.max(point.alongMeters - LANE_CHANGE_SETTLE_METERS, shiftStart + 1);
  const offsetAt = (along: number): number => {
    if (exitOffset === undefined) return 0;
    if (along > point.alongMeters) {
      const handover = Math.min((along - point.alongMeters) / RAMP_HANDOVER_METERS, 1);
      return exitOffset * (1 - handover);
    }
    const t = Math.min(Math.max((along - shiftStart) / (shiftEnd - shiftStart), 0), 1);
    return cameraOffset + (exitOffset - cameraOffset) * t * t * (3 - 2 * t);
  };
  const eye = offsetRight(camera.point, axisBearing, cameraOffset);

  const points: PhotoPathPoint[] = [];
  for (let along = startAlong; along <= endAlong; along += SAMPLE_STEP_METERS) {
    const onRoute = positionAt(geometry, cum, along);
    const sample = offsetRight(onRoute.point, onRoute.bearing, offsetAt(along));
    const sampleBearing = bearingBetween(eye, sample);
    const relativeDeg = normalizeSigned(sampleBearing - axisBearing);
    if (Math.abs(relativeDeg) > halfWidthDeg - FRAME_EDGE_MARGIN_DEG) break;
    const distanceMeters = along - camera.alongMeters;
    const belowHorizonDeg = toDegrees(Math.atan(cameraHeight / distanceMeters));
    const xPercent = image.isPano
      ? HORIZON_PERCENT +
        (normalizeSigned(sampleBearing - panoCentreBearing) / PANO_WIDTH_DEG) * 100
      : 50 + (Math.tan(toRadians(relativeDeg)) / Math.tan(toRadians(halfWidthDeg))) * 50;
    const yPercent = image.isPano
      ? HORIZON_PERCENT + (belowHorizonDeg / PANO_HEIGHT_DEG) * 100
      : HORIZON_PERCENT +
        (Math.tan(toRadians(belowHorizonDeg)) / Math.tan(toRadians(halfHeightDeg))) * 50;
    if (yPercent > 100) break;
    const laneHalfDeg = toDegrees(Math.atan(PATH_HALF_WIDTH_M / distanceMeters));
    const widthPercent = image.isPano
      ? ((2 * laneHalfDeg) / PANO_WIDTH_DEG) * 100
      : (Math.tan(toRadians(laneHalfDeg)) / Math.tan(toRadians(halfWidthDeg))) * 100;
    points.push({ xPercent, yPercent, widthPercent, distanceMeters });
  }

  if (points.length < 2) return hidden(panoCrop);
  const endBearing = positionAt(geometry, cum, endAlong).bearing;
  return {
    points,
    headRotateDeg: normalizeSigned(endBearing - axisBearing),
    ...(panoCrop ? { crop: panoCrop } : {}),
    laneShiftMeters: exitOffset === undefined ? 0 : exitOffset - cameraOffset,
    visible: true,
  };
}

/** Metres right of the carriageway centre of the exit lanes' middle, when the layout is known. */
function exitLaneOffset(exitLanes: PhotoProjectionOptions["exitLanes"]): number | undefined {
  if (!exitLanes || exitLanes.laneCount < 1 || exitLanes.activeLanes.length === 0) return undefined;
  const middle =
    exitLanes.activeLanes.reduce((sum, lane) => sum + lane, 0) / exitLanes.activeLanes.length;
  return (middle - (exitLanes.laneCount - 1) / 2) * LANE_WIDTH_M;
}

/** `point` moved `meters` to the right of travel at `bearingDeg`. */
function offsetRight(point: LngLat, bearingDeg: number, meters: number): LngLat {
  if (meters === 0) return point;
  const rad = toRadians(bearingDeg);
  const east = Math.cos(rad) * meters;
  const north = -Math.sin(rad) * meters;
  return [
    point[0] + east / (METERS_PER_DEGREE * Math.cos(toRadians(point[1]))),
    point[1] + north / METERS_PER_DEGREE,
  ];
}

/** Where a photo sits on the approach to a decision point. */
export interface ApproachCamera {
  alongMeters: number;
  point: LngLat;
  /** Travel bearing of the road there — the way a forward-facing camera looks. */
  bearing: number;
  deviationMeters: number;
  /**
   * The photo's GPS position across the road from the route line, metres,
   * positive to the right of travel — which lane it was shot from.
   */
  lateralOffsetMeters: number;
  /** Whether the photo is close enough to the route to describe this approach. */
  onApproach: boolean;
}

/**
 * Where on the approach the photo was taken: the closest point of the route in
 * the stretch leading up to the decision point. Working in route coordinates
 * rather than raw image coordinates cancels the photo's own GPS scatter, which
 * would otherwise slide the whole path sideways.
 */
export function approachCamera(
  geometry: LngLat[],
  cum: number[],
  point: JunctionDecisionPoint,
  imageLngLat: LngLat,
): ApproachCamera {
  const searchStart = Math.max(point.alongMeters - UPSTREAM_SEARCH_METERS, 0);
  let best = {
    alongMeters: searchStart,
    ...positionAt(geometry, cum, searchStart),
    deviationMeters: Number.POSITIVE_INFINITY,
  };
  for (let along = searchStart; along <= point.alongMeters; along += SEARCH_STEP_METERS) {
    const at = positionAt(geometry, cum, along);
    const deviationMeters = haversineDistance(at.point, imageLngLat);
    if (deviationMeters < best.deviationMeters)
      best = { alongMeters: along, ...at, deviationMeters };
  }
  const rad = toRadians(best.bearing);
  const east =
    (imageLngLat[0] - best.point[0]) * METERS_PER_DEGREE * Math.cos(toRadians(best.point[1]));
  const north = (imageLngLat[1] - best.point[1]) * METERS_PER_DEGREE;
  return {
    ...best,
    lateralOffsetMeters: east * Math.cos(rad) - north * Math.sin(rad),
    onApproach: best.deviationMeters <= MAX_CAMERA_OFFSET_METERS,
  };
}

/** The 90° window centred on the approach, for cropping a panorama. */
function cropWindow(centreBearing: number): PhotoCropWindow {
  return {
    startDeg: normalizeDeg(centreBearing - PANO_CROP_SPAN_DEG / 2),
    spanDeg: PANO_CROP_SPAN_DEG,
  };
}

function hidden(crop?: PhotoCropWindow): PhotoRoutePath {
  return {
    points: [],
    headRotateDeg: 0,
    ...(crop ? { crop } : {}),
    laneShiftMeters: 0,
    visible: false,
  };
}

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

function toDegrees(radians: number): number {
  return (radians * 180) / Math.PI;
}

function normalizeDeg(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

/** Normalise a signed delta to (−180, 180]. */
function normalizeSigned(delta: number): number {
  const wrapped = ((delta + 540) % 360) - 180;
  return wrapped === -180 ? 180 : wrapped;
}
