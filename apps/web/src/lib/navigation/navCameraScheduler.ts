import type { PaddingOptions } from "maplibre-gl";

/**
 * Visibility predicates for the navigation camera loop, kept pure and free of
 * MapLibre so the wake/sleep rule can be exercised without a map, a marker or a
 * frame clock.
 *
 * The loop has two jobs that are easy to conflate: integrating a pose every
 * frame, and publishing that pose to MapLibre. Publication is the expensive
 * half, so it happens only once a pose has moved far enough to be visible —
 * and when nothing has been published for a couple of frames there is, by
 * definition, nothing left to animate and the loop can stop asking for frames.
 */

/**
 * Puck thresholds. Repositioning a DOM marker is cheap, so these sit far below
 * anything renderable (~0.1 mm, ~0.0001°) and exist only to recognise a pose
 * that has genuinely stopped converging. Anything a traveller can do — down to
 * a walking pace — clears them on every frame, so the puck's moving cadence is
 * exactly the frame cadence.
 */
export const PUCK_LNGLAT_EPSILON = 1e-9;
export const PUCK_BEARING_EPSILON = 1e-4;
/**
 * Camera thresholds. A `jumpTo` transforms and repaints the whole map, so it is
 * worth suppressing for a move nobody can see: ~0.1 m of centre drift, a
 * twentieth of a degree of rotation, and four thousandths of a zoom level.
 */
export const CAMERA_LNGLAT_EPSILON = 1e-6;
export const CAMERA_BEARING_EPSILON = 0.05;
export const CAMERA_ZOOM_EPSILON = 0.004;
/**
 * Pitch threshold. The approach tilt eases at a second-scale time constant, so
 * a fifth of a degree per published frame is well inside the visible slope —
 * anything smaller reads as a converged pitch.
 */
export const CAMERA_PITCH_EPSILON = 0.2;
/**
 * Where a scalar ease counts as arrived. Far below the publication thresholds:
 * an ease's per-frame steps fall under those long before it has arrived, so
 * they cannot be what ends it (see `settleScalar`), and landing on the target
 * from this close never moves a published pose by anything visible.
 */
export const CAMERA_PITCH_SETTLED_DEG = 0.01;
export const CAMERA_ZOOM_SETTLED = 0.0005;
/**
 * Padding threshold. Padding shifts the whole projection, so it is measured in
 * the same screen pixels the chrome that produced it is: half a pixel is the
 * finest move that can land on a different device pixel.
 */
export const CAMERA_PADDING_EPSILON = 0.5;
/**
 * Consecutive frames that must publish nothing before the loop sleeps. Two,
 * because the first frame after a wake runs with dt = 0 — the filters cannot
 * move on it, so a single settled frame is not evidence that the pose has
 * converged.
 */
export const SETTLED_FRAMES_BEFORE_SLEEP = 2;

export interface PuckPose {
  lng: number;
  lat: number;
  bearing: number;
}

export interface CameraPose extends PuckPose {
  zoom: number;
  pitch?: number;
  padding?: Required<PaddingOptions>;
}

/** Shortest angular distance between two bearings, degrees, always positive. */
function bearingDistance(a: number, b: number): number {
  return Math.abs(((a - b + 540) % 360) - 180);
}

function poseChanged(
  last: PuckPose | null,
  next: PuckPose,
  lngLatEpsilon: number,
  bearingEpsilon: number,
): boolean {
  return (
    !last ||
    Math.abs(next.lng - last.lng) > lngLatEpsilon ||
    Math.abs(next.lat - last.lat) > lngLatEpsilon ||
    bearingDistance(next.bearing, last.bearing) > bearingEpsilon
  );
}

/**
 * Whether a puck pose has moved far enough since the last published one to be
 * worth another `setLngLat`/`setRotation`. A missing previous pose counts as
 * changed: the puck has never been placed, or a route/map swap invalidated it.
 */
export function puckPoseChanged(last: PuckPose | null, next: PuckPose): boolean {
  return poseChanged(last, next, PUCK_LNGLAT_EPSILON, PUCK_BEARING_EPSILON);
}

/** A pose that carries no padding leaves the map's padding alone, so it never counts as changed. */
function paddingChanged(
  last: Required<PaddingOptions> | undefined,
  next: Required<PaddingOptions> | undefined,
): boolean {
  if (!next) return false;
  if (!last) return true;
  return (
    Math.abs(next.top - last.top) > CAMERA_PADDING_EPSILON ||
    Math.abs(next.bottom - last.bottom) > CAMERA_PADDING_EPSILON ||
    Math.abs(next.left - last.left) > CAMERA_PADDING_EPSILON ||
    Math.abs(next.right - last.right) > CAMERA_PADDING_EPSILON
  );
}

/** A pose that carries no pitch leaves the map's pitch alone, so it never counts as changed. */
function pitchChanged(last: number | undefined, next: number | undefined): boolean {
  if (next === undefined) return false;
  if (last === undefined) return true;
  return Math.abs(next - last) > CAMERA_PITCH_EPSILON;
}

/**
 * Whether a camera pose warrants another `jumpTo`. Zoom only participates while
 * the loop still commands zoom — once the user has taken zoom control the loop
 * leaves it alone, so a zoom delta must not by itself force a camera transform.
 */
export function cameraPoseChanged(
  last: CameraPose | null,
  next: CameraPose,
  commandsZoom: boolean,
): boolean {
  if (poseChanged(last, next, CAMERA_LNGLAT_EPSILON, CAMERA_BEARING_EPSILON)) return true;
  if (paddingChanged(last?.padding, next.padding)) return true;
  if (pitchChanged(last?.pitch, next.pitch)) return true;
  return commandsZoom && !!last && Math.abs(next.zoom - last.zoom) > CAMERA_ZOOM_EPSILON;
}

/**
 * An eased scalar (pitch, zoom), landed on its target once within `settledWithin`
 * of it. Until then the ease is still under way, and the frame must say so: a
 * one-second ease moves a fraction of a degree per frame, under the threshold
 * that publishes it, so with the traveller stopped (no puck movement to keep
 * the loop awake) the loop would sleep two frames in and leave the tilt short.
 * Kept running, the steps add up and publish every few frames instead.
 */
export function settleScalar(value: number, target: number, settledWithin: number): number {
  return Math.abs(target - value) <= settledWithin ? target : value;
}

export interface FrameSettlement {
  /** Whether this frame moved the puck or the camera. */
  publishedThisFrame: boolean;
  /**
   * Whether an eased scalar is still short of its target. Its steps may each be
   * too small to publish, so a frame that published nothing proves nothing.
   */
  easing: boolean;
  /** Consecutive frames that published nothing, counting this one. */
  settledFrames: number;
  /**
   * `performance.now()` value until which the loop must keep running whatever
   * the pose does — the enter-follow ease and the post-gesture grace window
   * both end with a camera hand-back that nothing else would wake.
   */
  holdUntilMs: number;
  nowMs: number;
}

/** Whether the loop should request another frame after the one just run. */
export function shouldKeepAnimating(frame: FrameSettlement): boolean {
  if (frame.nowMs < frame.holdUntilMs) return true;
  if (frame.publishedThisFrame || frame.easing) return true;
  return frame.settledFrames < SETTLED_FRAMES_BEFORE_SLEEP;
}
