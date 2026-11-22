import type { LngLat } from "../types/geometry";
import { bearingBetween } from "./bearing";
import { distanceAtVertex, positionAt } from "./deadReckon";

/**
 * Pure follow-camera framing for turn-by-turn navigation (immersive navigation
 * spec §6): where the camera looks, how close it sits at a given speed, and the
 * zoom at which an upcoming junction fits on screen. Map-free and unit-tested;
 * `useNavCamera` applies the results through its filters.
 */

export type NavCameraProfileName = "2d" | "3d";

export interface NavCameraProfile {
  drivingPitch: number;
  approachPitch: number;
  approachZoomCap: number;
  maxPitch: number;
}

/** The 2D values are today's; the 3D values apply only while 3D navigation is active. */
export const NAV_CAMERA_PROFILE: Readonly<Record<NavCameraProfileName, NavCameraProfile>> = {
  "2d": { drivingPitch: 55, approachPitch: 60, approachZoomCap: 17.5, maxPitch: 60 },
  "3d": { drivingPitch: 62, approachPitch: 68, approachZoomCap: 18, maxPitch: 70 },
};

const LOOK_AHEAD_SECONDS = 3;
const LOOK_AHEAD_MIN_M = 25;
const LOOK_AHEAD_MAX_M = 150;
const LOOK_AHEAD_END_M = 5;
const LOOK_AHEAD_LIMIT_MIN_M = 2;

/** How far along the route the camera aims: three seconds of travel, 25–150 m. */
export function lookAheadMeters(speedMps: number): number {
  const speed = Math.max(speedMps, 0);
  return Math.min(Math.max(speed * LOOK_AHEAD_SECONDS, LOOK_AHEAD_MIN_M), LOOK_AHEAD_MAX_M);
}

/**
 * Bearing from the route position at `alongMeters` to the point `aheadMeters`
 * further along the route, so the camera turns into a bend before the puck
 * does. Past the end of the route it aims at the final point; on the last 5 m
 * it returns null and the caller keeps the local bearing.
 *
 * `limitAlong` stops the target there when it lies ahead: before a junction
 * turn the camera keeps to the street, where buildings do not stand between it
 * and the puck, and turns as the puck crosses the junction. Within 2 m of the
 * limit there is nothing to aim at and it returns null.
 */
export function lookAheadBearing(
  geometry: LngLat[],
  cum: number[],
  alongMeters: number,
  aheadMeters: number,
  limitAlong?: number,
): number | null {
  if (geometry.length < 2) return null;
  const total = distanceAtVertex(cum, geometry.length - 1);
  const along = Math.min(Math.max(alongMeters, 0), total);
  if (total - along < LOOK_AHEAD_END_M) return null;
  let target = Math.min(along + Math.max(aheadMeters, 0), total);
  if (limitAlong !== undefined && limitAlong > along) {
    if (limitAlong - along < LOOK_AHEAD_LIMIT_MIN_M) return null;
    target = Math.min(target, limitAlong);
  }
  const from = positionAt(geometry, cum, along).point;
  const to = positionAt(geometry, cum, target).point;
  return bearingBetween(from, to);
}

/** Today's 2D curve (z17 standing still → z14 at motorway speed) and the closer 3D curve. */
export function speedZoom(speedMps: number, profile: NavCameraProfileName): number {
  const v = Math.max(speedMps, 0) / 33;
  if (profile === "3d") return Math.min(17.8, Math.max(15, 17.8 - v * 2.8));
  return Math.min(17, Math.max(14, 17 - v * 3));
}

/** Framing only ever pushes in from the speed zoom, and never past the cap. */
export function approachTargetZoom(speedZoomValue: number, fitZoom: number, cap: number): number {
  return Math.min(cap, Math.max(speedZoomValue, fitZoom));
}

export interface JunctionFitInput {
  legs: LngLat[];
  center: LngLat;
  bearing: number;
  pitch: number;
  viewport: { width: number; height: number };
  padding: { top: number; bottom: number; left: number; right: number };
  maxZoom: number;
  tileSize?: number;
}

/** MapLibre's vertical field of view. */
const FOV_RAD = 0.6435011087932844;
const FIT_STEP = 0.05;
const FIT_MAX_STEPS = 100;

function mercator([lng, lat]: LngLat): [number, number] {
  const clamped = Math.max(Math.min(lat, 85.0511), -85.0511);
  const s = Math.sin((clamped * Math.PI) / 180);
  return [(lng + 180) / 360, 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)];
}

/**
 * Whether every point projects inside the padded viewport at `zoom`, with a
 * pinhole camera like MapLibre's: the centre sits at the padded viewport's
 * centre, the camera is `height / 2 / tan(fov / 2)` pixels from it and tilted
 * by `pitch` about the screen's horizontal axis.
 */
function fitsAt(input: JunctionFitInput, points: [number, number][], zoom: number): boolean {
  const { viewport, padding } = input;
  const worldSize = (input.tileSize ?? 512) * 2 ** zoom;
  const [cx, cy] = mercator(input.center);
  const bearing = (input.bearing * Math.PI) / 180;
  const pitch = (input.pitch * Math.PI) / 180;
  const distance = viewport.height / 2 / Math.tan(FOV_RAD / 2);
  const screenCx = padding.left + (viewport.width - padding.left - padding.right) / 2;
  const screenCy = padding.top + (viewport.height - padding.top - padding.bottom) / 2;
  const cosB = Math.cos(bearing);
  const sinB = Math.sin(bearing);
  for (const [mx, my] of points) {
    const dx = (mx - cx) * worldSize;
    const dy = (my - cy) * worldSize;
    // Rotate so the camera bearing points up the screen.
    const x = dx * cosB + dy * sinB;
    const y = -dx * sinB + dy * cosB;
    const ahead = -y;
    const depth = distance + ahead * Math.sin(pitch);
    if (depth <= 1e-6) return false;
    const scale = distance / depth;
    const sx = screenCx + x * scale;
    const sy = screenCy - ahead * Math.cos(pitch) * scale;
    if (sx < padding.left - 1e-6 || sx > viewport.width - padding.right + 1e-6) return false;
    if (sy < padding.top - 1e-6 || sy > viewport.height - padding.bottom + 1e-6) return false;
  }
  return true;
}

/**
 * The largest zoom ≤ `maxZoom` at which every leg point lies inside the padded
 * viewport. Steps down in 0.05 increments (at most 100 steps), so the answer is
 * at most 0.05 below the exact fit and never above it.
 */
export function junctionFitZoom(input: JunctionFitInput): number {
  const points = input.legs.map(mercator);
  let zoom = input.maxZoom;
  for (let i = 0; i < FIT_MAX_STEPS; i++) {
    if (fitsAt(input, points, zoom)) return zoom;
    zoom -= FIT_STEP;
  }
  return zoom;
}
