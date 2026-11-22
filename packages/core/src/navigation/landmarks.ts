import type { LngLat } from "../types/geometry";
import type { Route } from "../types/routing";
import { haversineDistance } from "../utils/coordinates";
import { bearingBetween } from "./bearing";
import {
  isMotorwayStep,
  isTurnManeuver,
  type LandmarkReference,
  type SpokenLandmarkCategory,
} from "./references";

/**
 * Landmarks a voice prompt may name at a manoeuvre ("at the Aral petrol
 * station"). The routing integration's `POST /navigation/landmarks` answers
 * with these candidates per manoeuvre point; selection happens on the client.
 */

/** OSM categories the server returns; `place_of_worship` is narrowed by `religion`. */
export type LandmarkCandidateCategory =
  | "fuel"
  | "place_of_worship"
  | "pharmacy"
  | "supermarket"
  | "fast_food";

export interface LandmarkCandidate {
  category: LandmarkCandidateCategory;
  /** OSM `brand`, at most 40 characters. Required for `fast_food`. */
  brand?: string;
  /** OSM `religion` for `place_of_worship`: christian, muslim or jewish. */
  religion?: string;
  /** The node, or the centre of a way or relation. */
  lat: number;
  lon: number;
  /** A way's outline as `[lng, lat]` pairs, for the distance rule. */
  outline?: [number, number][];
}

/** The manoeuvre a landmark is chosen for. */
export interface LandmarkManeuver {
  stepIndex: number;
  point: LngLat;
  /** Heading arriving at the manoeuvre, degrees. */
  bearingIn: number;
  bearingOut: number;
  modifier: string;
}

/** A candidate this close to the manoeuvre point, on the turn side, qualifies. */
const TURN_SIDE_M = 30;
/** Slight turns have no clear side; either corner, but closer. */
const SLIGHT_EITHER_SIDE_M = 20;
/** Another landmark of the same kind this close makes the reference ambiguous. */
const UNIQUE_WITHIN_M = 150;
/**
 * Same kind and brand this close together is one place mapped twice (a fuel
 * station's node and its forecourt area, say), not two.
 */
const SAME_PLACE_M = 50;
/** Below this the candidate sits on the manoeuvre point; its side is moot. */
const ON_POINT_M = 2;
const MAX_BRAND = 40;
const BRANDED: ReadonlySet<SpokenLandmarkCategory> = new Set(["fuel", "supermarket", "fast_food"]);
const RELIGION_WORD: Readonly<Record<string, SpokenLandmarkCategory>> = {
  christian: "church",
  muslim: "mosque",
  jewish: "synagogue",
};

/** The spoken category, or null for a candidate a prompt cannot name. */
function spokenCategory(candidate: LandmarkCandidate): SpokenLandmarkCategory | null {
  if (candidate.category === "place_of_worship") {
    return RELIGION_WORD[candidate.religion ?? ""] ?? null;
  }
  return candidate.category;
}

function spokenBrand(candidate: LandmarkCandidate, category: SpokenLandmarkCategory) {
  const brand = candidate.brand?.trim();
  return BRANDED.has(category) && brand && brand.length <= MAX_BRAND ? brand : undefined;
}

/** Metres east and north of `origin`; accurate enough within a few hundred metres. */
function localXY(origin: LngLat, point: LngLat): [number, number] {
  const metresPerDegLat = 111_320;
  const metresPerDegLon = metresPerDegLat * Math.cos((origin[1] * Math.PI) / 180);
  return [(point[0] - origin[0]) * metresPerDegLon, (point[1] - origin[1]) * metresPerDegLat];
}

/** The candidate's point nearest the manoeuvre, in local metres. */
function nearestXY(origin: LngLat, candidate: LandmarkCandidate): [number, number] {
  const centre = localXY(origin, [candidate.lon, candidate.lat]);
  const outline = candidate.outline?.map((vertex) => localXY(origin, vertex)) ?? [];
  let best = centre;
  let bestDistance = Math.hypot(...centre);
  for (let i = 0; i + 1 < outline.length; i++) {
    const [ax, ay] = outline[i] as [number, number];
    const [bx, by] = outline[i + 1] as [number, number];
    const dx = bx - ax;
    const dy = by - ay;
    const lengthSq = dx * dx + dy * dy;
    const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / lengthSq));
    const point: [number, number] = [ax + t * dx, ay + t * dy];
    const distance = Math.hypot(...point);
    if (distance < bestDistance) {
      best = point;
      bestDistance = distance;
    }
  }
  return best;
}

interface Measured {
  candidate: LandmarkCandidate;
  category: SpokenLandmarkCategory;
  brand: string | undefined;
  distance: number;
  /** Signed angle from the incoming bearing; positive is to the right. */
  angle: number;
  position: [number, number];
}

/**
 * The landmark a prompt may name at this manoeuvre, or null.
 *
 * A candidate qualifies when its node, or the nearest point of its outline, is
 * within 30 m of the manoeuvre point on the side the route turns to (slight
 * turns: either side within 20 m), and no other landmark of the same spoken
 * kind lies within 150 m, so the prompt points at one place. The nearest
 * qualifying landmark wins. The OSM name is never used.
 */
export function selectLandmark(
  maneuver: LandmarkManeuver,
  candidates: LandmarkCandidate[],
): LandmarkReference | null {
  const modifier = maneuver.modifier.toLowerCase().replace(/[-_]/g, " ");
  const turnSide = modifier.includes("left") ? -1 : modifier.includes("right") ? 1 : 0;
  if (turnSide === 0) return null;
  const slight = modifier.startsWith("slight");

  const measured: Measured[] = [];
  for (const candidate of candidates) {
    const category = spokenCategory(candidate);
    if (!category) continue;
    const brand = spokenBrand(candidate, category);
    // Fast food is named only by its brand.
    if (category === "fast_food" && brand === undefined) continue;
    const position = nearestXY(maneuver.point, candidate);
    const bearing = (Math.atan2(position[0], position[1]) * 180) / Math.PI;
    const angle = ((((bearing - maneuver.bearingIn + 540) % 360) + 360) % 360) - 180;
    measured.push({
      candidate,
      category,
      brand,
      distance: Math.hypot(...position),
      angle,
      position,
    });
  }

  const qualifies = (entry: Measured): boolean => {
    if (entry.distance <= ON_POINT_M) return true;
    if (slight && entry.distance <= SLIGHT_EITHER_SIDE_M) return true;
    return entry.distance <= TURN_SIDE_M && Math.sign(entry.angle) === turnSide;
  };
  const samePlace = (a: Measured, b: Measured): boolean =>
    a.category === b.category &&
    a.brand === b.brand &&
    haversineDistance([a.candidate.lon, a.candidate.lat], [b.candidate.lon, b.candidate.lat]) <=
      SAME_PLACE_M;
  const unique = (entry: Measured): boolean =>
    !measured.some(
      (other) =>
        other !== entry &&
        other.category === entry.category &&
        other.distance <= UNIQUE_WITHIN_M &&
        !samePlace(entry, other),
    );

  const chosen = measured
    .filter((entry) => qualifies(entry) && unique(entry))
    .sort((a, b) => a.distance - b.distance)[0];
  if (!chosen) return null;
  return {
    stepIndex: maneuver.stepIndex,
    category: chosen.category,
    ...(chosen.brand !== undefined && { brand: chosen.brand }),
  };
}

/**
 * The manoeuvre at `stepIndex` as landmark selection needs it: its point, and
 * the bearings in and out, from the engine or else the step geometry. Null
 * without a modifier, a point or a way to tell the bearings.
 */
export function landmarkManeuverAt(route: Route, stepIndex: number): LandmarkManeuver | null {
  const step = route.steps[stepIndex];
  const point = step?.coordinates[0];
  const modifier = step?.maneuver?.modifier;
  if (!step || !point || !modifier) return null;
  const before = route.steps[stepIndex - 1]?.coordinates;
  const previousPoint = before && before.length >= 2 ? before.at(-2) : undefined;
  const nextPoint = step.coordinates[1];
  const bearingIn =
    step.bearingBefore ?? (previousPoint ? bearingBetween(previousPoint, point) : null);
  const bearingOut = step.bearingAfter ?? (nextPoint ? bearingBetween(point, nextPoint) : null);
  if (bearingIn === null || bearingOut === null) return null;
  return { stepIndex, point, bearingIn, bearingOut, modifier };
}

/** Manoeuvres this close to the trip's origin or destination are not looked up. */
const ENDPOINT_EXCLUSION_M = 300;

/**
 * Step indices whose manoeuvre may get a landmark: turns off the motorway,
 * more than 300 m from the route's first and last point.
 */
export function eligibleLandmarkManeuvers(route: Route): number[] {
  const first = route.geometry[0];
  const last = route.geometry.at(-1);
  if (!first || !last) return [];
  const eligible: number[] = [];
  route.steps.forEach((step, index) => {
    const point = step.coordinates[0];
    if (!point || !isTurnManeuver(step) || isMotorwayStep(route.steps, index)) return;
    if (haversineDistance(point, first) <= ENDPOINT_EXCLUSION_M) return;
    if (haversineDistance(point, last) <= ENDPOINT_EXCLUSION_M) return;
    eligible.push(index);
  });
  return eligible;
}
