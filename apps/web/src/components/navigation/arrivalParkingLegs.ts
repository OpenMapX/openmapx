import { type DirectionsResult, haversineDistance, type LngLat, type Route } from "@openmapx/core";
import { contributorsForField, snapshotContributors } from "@openmapx/mobility-core/contributors";
import type { NearbyParkingPlace, ParkingWalk } from "./nearbyParking";
import { getParkingCoords } from "./parkingCoords";

/** How many of the closest candidates are measured along the networks. */
export const MEASURED_PARKING = 6;
/** How many candidates the card offers. */
export const OFFERED_PARKING = 4;
/** Route requests in flight at once. */
const CONCURRENCY = 2;

/**
 * What it takes to use a car park from where the car is: the drive to it and
 * the walk from it to the destination. `unreachable` when a router answered
 * that either leg has no route; `unknown` when a leg could not be measured.
 */
export type ParkingLegs =
  | { id: string; kind: "network"; driveSeconds: number; walk: ParkingWalk }
  | { id: string; kind: "unknown" | "unreachable" };

export interface MeasureParkingInput {
  /** Where the car is. */
  from: LngLat;
  destination: LngLat;
  candidates: readonly NearbyParkingPlace[];
  signal: AbortSignal;
  /** Plans a drive with the session's mode and route options. */
  drive: (waypoints: LngLat[], signal: AbortSignal) => Promise<DirectionsResult>;
  /** Plans a walk. */
  walk: (waypoints: LngLat[], signal: AbortSignal) => Promise<DirectionsResult>;
}

function checkAbort(signal: AbortSignal): void {
  if (!signal.aborted) return;
  const error = new Error("Parking measurement cancelled");
  error.name = "AbortError";
  throw error;
}

function selectedRoute(result: DirectionsResult): Route | undefined {
  const route = result.routes?.[result.activeRouteIndex ?? 0];
  return route &&
    Number.isFinite(route.duration) &&
    route.duration >= 0 &&
    Number.isFinite(route.distance) &&
    route.distance >= 0
    ? route
    : undefined;
}

/** A router's explicit answer that there is no route, as opposed to a failure. */
function noRoute(result: DirectionsResult): boolean {
  return Array.isArray(result.routes) && result.routes.length === 0;
}

async function measure(
  candidate: NearbyParkingPlace,
  input: MeasureParkingInput,
): Promise<ParkingLegs> {
  const { id } = candidate;
  const parking = getParkingCoords(candidate);
  if (!parking) return { id, kind: "unknown" };
  const { signal } = input;
  try {
    const driveResult = await input.drive([input.from, parking], signal);
    checkAbort(signal);
    if (noRoute(driveResult)) return { id, kind: "unreachable" };
    const drive = selectedRoute(driveResult);
    if (!drive) return { id, kind: "unknown" };
    const walkResult = await input.walk([parking, input.destination], signal);
    checkAbort(signal);
    if (noRoute(walkResult)) return { id, kind: "unreachable" };
    const walk = selectedRoute(walkResult);
    if (!walk) return { id, kind: "unknown" };
    return {
      id,
      kind: "network",
      driveSeconds: drive.duration,
      walk: {
        seconds: walk.duration,
        meters: walk.distance,
        contributors: snapshotContributors(
          contributorsForField(walk, "duration"),
          contributorsForField(walk, "distance"),
        ),
      },
    };
  } catch {
    checkAbort(signal);
    return { id, kind: "unknown" };
  }
}

/**
 * Measures the drive to each candidate and the walk from it to the
 * destination, a bounded shortlist at a time. A failed leg leaves its
 * candidate unknown; cancelling rejects with an `AbortError`.
 */
export async function measureParkingLegs(input: MeasureParkingInput): Promise<ParkingLegs[]> {
  checkAbort(input.signal);
  const candidates = input.candidates.slice(0, MEASURED_PARKING);
  const results: ParkingLegs[] = candidates.map(({ id }) => ({ id, kind: "unknown" }));
  let next = 0;
  const worker = async () => {
    while (next < candidates.length) {
      const index = next++;
      const candidate = candidates[index];
      if (candidate) results[index] = await measure(candidate, input);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, candidates.length) }, worker));
  checkAbort(input.signal);
  return results;
}

/** Candidates closest first, a site reported full after every site that may have room. */
export function byDistance(
  candidates: readonly NearbyParkingPlace[],
  destination: LngLat,
): NearbyParkingPlace[] {
  return candidates
    .flatMap((place) => {
      const coordinates = getParkingCoords(place);
      return coordinates ? [{ place, distance: haversineDistance(coordinates, destination) }] : [];
    })
    .sort(
      (left, right) =>
        Number(left.place.full === true) - Number(right.place.full === true) ||
        left.distance - right.distance,
    )
    .map(({ place }) => place);
}

/** A candidate with its measured drive and walk in seconds, and its place by distance. */
interface RankedParking {
  place: NearbyParkingPlace;
  cost?: number;
  distanceRank: number;
}

/**
 * The candidates to offer. Without measurements, closest first. With them, a
 * car park no route reaches is left out, and the measured ones lead, quickest
 * drive and walk together first; a site reported full still goes last, and
 * one that could not be measured keeps its place by distance after them.
 */
export function rankParking(
  closestFirst: readonly NearbyParkingPlace[],
  legs: readonly ParkingLegs[] | null,
): NearbyParkingPlace[] {
  if (!legs) return closestFirst.slice(0, OFFERED_PARKING);
  const byId = new Map(legs.map((leg) => [leg.id, leg]));
  return closestFirst
    .flatMap((place, distanceRank): RankedParking[] => {
      const leg = byId.get(place.id);
      if (leg?.kind === "unreachable") return [];
      return leg?.kind === "network"
        ? [
            {
              place: { ...place, walk: leg.walk },
              cost: leg.driveSeconds + leg.walk.seconds,
              distanceRank,
            },
          ]
        : [{ place, distanceRank }];
    })
    .sort((left, right) => {
      const full = Number(left.place.full === true) - Number(right.place.full === true);
      if (full !== 0) return full;
      if (left.cost !== undefined && right.cost !== undefined) return left.cost - right.cost;
      if (left.cost !== undefined) return -1;
      if (right.cost !== undefined) return 1;
      return left.distanceRank - right.distanceRank;
    })
    .slice(0, OFFERED_PARKING)
    .map(({ place }) => place);
}
