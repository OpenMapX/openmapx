import type { ServiceVehicle, ServiceVehicleActivity } from "@openmapx/integration-framework";
import {
  type CreditSources,
  credit,
  instantOf,
  NO_SOURCES,
  noticeCredits,
  pointOf,
  type Rec,
  rec,
  sourcesOf,
  str,
  upstreamCredits,
} from "../features/record.js";

const ACTIVITIES: ReadonlySet<string> = new Set<ServiceVehicleActivity>([
  "plowing",
  "salting",
  "sanding",
  "deadheading",
  "idle",
  "responding",
  "unknown",
]);

const lonLat = (value: unknown): [number, number] | undefined =>
  Array.isArray(value) &&
  typeof value[0] === "number" &&
  typeof value[1] === "number" &&
  Number.isFinite(value[0]) &&
  Number.isFinite(value[1])
    ? [value[0], value[1]]
    : undefined;

/** A `trail` LineString's positions; none for anything else or fewer than two positions. */
function trailOf(value: unknown): [number, number][] | undefined {
  const line = rec(value);
  if (line.type !== "LineString" || !Array.isArray(line.coordinates)) return undefined;
  const positions = line.coordinates.map(lonLat);
  if (positions.length < 2 || positions.some((p) => p === undefined)) return undefined;
  return positions as [number, number][];
}

/**
 * One `vehicle.position` reading as a service vehicle: placed at its
 * `vehicle_position` point (or the reading's location), with its trail, what
 * it says the vehicle is doing and the publisher's task codes from its extras. Null
 * for a reading of another property, or one without a place, a time or a
 * source.
 */
export function readingToServiceVehicle(
  record: Rec,
  sources: CreditSources = NO_SOURCES,
): ServiceVehicle | null {
  const result = rec(record.result);
  const value = rec(result.value);
  const coordinates = pointOf({ geometry: value.point }) ?? pointOf(rec(record.location));
  const observedAt = instantOf(record.phenomenonTime);
  const kept = sourcesOf(record);
  const id = str(record.id);
  if (
    record.property !== "vehicle.position" ||
    result.type !== "structured" ||
    !id ||
    !coordinates ||
    !observedAt ||
    kept.length === 0
  ) {
    return null;
  }
  const bearing = value.bearingDeg;
  const activity = str(value.activity);
  const tasks = rec(record.extras).tasks;
  const expiresAt = str(rec(record.freshness).expiresAt);
  const trail = trailOf(value.trail);
  return {
    id,
    coordinates,
    ...(trail ? { trail } : {}),
    ...(typeof bearing === "number" && bearing >= 0 && bearing < 360
      ? { bearingDeg: bearing }
      : {}),
    ...(activity && ACTIVITIES.has(activity)
      ? { activity: activity as ServiceVehicleActivity }
      : {}),
    ...(value.plowUp === false
      ? { plowDown: true }
      : value.plowUp === true
        ? { plowDown: false }
        : {}),
    ...(typeof value.spreaderOn === "boolean" ? { spreaderOn: value.spreaderOn } : {}),
    tasks: Array.isArray(tasks)
      ? tasks.filter((t): t is string => typeof t === "string" && t.length > 0)
      : [],
    observedAt,
    ...(expiresAt ? { expiresAt } : {}),
    sources: kept.map((s) => s.id),
    attributions: [
      ...kept.map((s) => credit(s, sources)),
      ...upstreamCredits(kept, sources),
      ...noticeCredits(kept, sources),
    ],
  };
}
