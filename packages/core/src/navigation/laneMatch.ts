import type { ManeuverLane } from "../types/routing";

/**
 * Whether the routing engine's lanes at a maneuver and the OSM lanes of the
 * way the car arrives on describe the same lanes (immersive navigation spec
 * §4.2, §9.2). Only exact agreement lets the map mark lanes on the road; any
 * doubt draws nothing. Pure and dependency-free: the map-details worker imports
 * it through the package subpath `@openmapx/core/navigation/laneMatch`.
 */

export type LaneIndication =
  | "through"
  | "left"
  | "slight_left"
  | "sharp_left"
  | "right"
  | "slight_right"
  | "sharp_right"
  | "reverse"
  | "merge_to_left"
  | "merge_to_right"
  | "none";

const INDICATIONS = new Set<LaneIndication>([
  "through",
  "left",
  "slight_left",
  "sharp_left",
  "right",
  "slight_right",
  "sharp_right",
  "reverse",
  "merge_to_left",
  "merge_to_right",
  "none",
]);

/** One lane indication in its canonical form, from engine or OSM spelling; empty is `none`. */
export function normaliseIndication(value: string): LaneIndication | null {
  const token = value.trim().toLowerCase().replace(/[-\s]/g, "_");
  if (token === "") return "none";
  if (token === "straight") return "through";
  if (token === "uturn" || token === "u_turn") return "reverse";
  return INDICATIONS.has(token as LaneIndication) ? (token as LaneIndication) : null;
}

/** The canonical indication set of a lane, as a comparable key. */
function laneKey(values: readonly string[]): string | null {
  const set = new Set<LaneIndication>();
  for (const value of values.length > 0 ? values : [""]) {
    const indication = normaliseIndication(value);
    if (!indication) return null;
    set.add(indication);
  }
  return [...set].sort().join(",");
}

export type LaneMatch =
  | { agree: true; engineToOsm: number[] }
  | { agree: false; reason: "no-lanes" | "count" | "turn-missing" | "indications" };

/**
 * Exact agreement: after dropping cycle lanes, the same number of lanes, every
 * OSM lane with turn values, and the same indications lane by lane. An OSM
 * lane marked only `none` (or empty) agrees with an engine lane that only says
 * `through`: the engine reads an unmarked lane as straight on (Spike B, spec
 * §4.3). `engineToOsm[i]` is engine lane `i`'s index in the given OSM list.
 */
export function matchLanes(
  engine: readonly ManeuverLane[],
  osm: readonly { kind: "general" | "bus" | "cycle"; turn: string[] | null }[],
): LaneMatch {
  if (engine.length === 0) return { agree: false, reason: "no-lanes" };
  const motor = osm.flatMap((lane, index) => (lane.kind === "cycle" ? [] : [{ lane, index }]));
  if (motor.length !== engine.length) return { agree: false, reason: "count" };
  if (motor.some(({ lane }) => lane.turn === null)) return { agree: false, reason: "turn-missing" };
  for (let i = 0; i < engine.length; i++) {
    const engineKey = laneKey((engine[i] as ManeuverLane).indications);
    const osmKey = laneKey(motor[i]?.lane.turn ?? []);
    if (engineKey === null || osmKey === null) return { agree: false, reason: "indications" };
    const unmarkedThrough = osmKey === "none" && engineKey === "through";
    if (engineKey !== osmKey && !unmarkedThrough) return { agree: false, reason: "indications" };
  }
  return { agree: true, engineToOsm: motor.map(({ index }) => index) };
}
