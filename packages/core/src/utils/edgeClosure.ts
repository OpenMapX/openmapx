export interface EdgeClosureInput {
  type: string;
  roadState?: string | null;
  vehiclesAffected?: readonly string[] | null;
}

/** Vehicle-class tokens (DATEX/WZDx/OpenConditions) that mean "ordinary cars too". */
export const PASSENGER_CAR_CLASSES: ReadonlySet<string> = new Set([
  "car",
  "cars",
  "passenger_car",
  "passenger_cars",
  "all",
  "any_vehicle",
  "all_vehicles",
  "motor_vehicle",
  "motor_vehicles",
  "vehicle",
  "vehicles",
]);

/**
 * Case- and separator-insensitive form of a vehicle-class token. Sources spell
 * the same class as `any_vehicle`, `anyVehicle`, `any-vehicle` or `ANY_VEHICLE`
 * (DATEX II is camelCase, WZDx snake_case), and a token we fail to recognise
 * silently turns a full closure into "lorries only" — no edge closure AND no
 * point exclusion. Both sides of the comparison are normalised so none of those
 * spellings can slip through.
 */
function normalizeVehicleClass(token: string): string {
  return token.toLowerCase().replace(/[_-]/g, "");
}

const NORMALIZED_PASSENGER_CAR_CLASSES: ReadonlySet<string> = new Set(
  [...PASSENGER_CAR_CLASSES].map(normalizeVehicleClass),
);

/**
 * The single rule for "this condition closes the road to everyone": a
 * `road_closure` that is not reported open, or any condition whose `roadState`
 * is `closed`; and not scoped to a vehicle class that excludes passenger cars.
 * Shared by the traffic writer (edge closures) and the routing integration
 * (which skips point exclusions for exactly these events), so both sides agree
 * on what an edge closure is.
 */
export function isEdgeClosure(e: EdgeClosureInput): boolean {
  const closes = (e.type === "road_closure" && e.roadState !== "open") || e.roadState === "closed";
  if (!closes) return false;
  const classes = (e.vehiclesAffected ?? []).map(normalizeVehicleClass);
  if (classes.length === 0) return true;
  return classes.some((c) => NORMALIZED_PASSENGER_CAR_CLASSES.has(c));
}

/**
 * Only these binding statuses may influence routing. The emitter also publishes
 * `ambiguous`, which is fine for display but must never move an edge.
 */
export function isRoutingRelevantBinding(status: string | undefined): boolean {
  return status === "exact" || status === "likely";
}
