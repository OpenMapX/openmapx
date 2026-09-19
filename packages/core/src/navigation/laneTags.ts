import type {
  GantryModel,
  GantryPanel,
  JunctionDecisionPoint,
  JunctionWay,
  OsmLaneTags,
} from "../types/junction";
import { angularDifference } from "./bearing";

/**
 * OSM per-lane destination tags → the gantry drawn in the junction panel.
 * OSM `:lanes` values run left to right in way direction — the same order as
 * the engines' lane arrays, so lane index 0 is the leftmost lane everywhere.
 */

/** Split a `|`-delimited `:lanes` value into per-lane strings, trimmed. */
function splitLaneValues(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  return raw.split("|").map((v) => v.trim());
}

/**
 * A per-lane value list with exactly `laneCount` entries, or `undefined` when
 * the tag disagrees with the lane count. A trailing `|` (an untagged last
 * lane) splits into an empty entry and still counts, so `a|b|` fits three
 * lanes; a genuinely shorter or longer list is not guessed at.
 */
function laneValues(values: string[] | undefined, laneCount: number): string[] | undefined {
  if (values === undefined) return undefined;
  return values.length === laneCount ? values : undefined;
}

/** Split one lane's value into its semicolon-separated parts, trimmed, empties dropped. */
function splitParts(value: string): string[] {
  return value
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * Separate road refs from place names found in a `destination:ref` value. A
 * road ref always carries a number ("A 46", "L 381", "M25"); a town never
 * does, so a digit-free value is a destination tagged into the wrong key.
 */
function splitRefParts(parts: string[]): { refs: string[]; places: string[] } {
  const hasNumber = (part: string) => /\d/.test(part);
  return { refs: parts.filter(hasNumber), places: parts.filter((part) => !hasNumber(part)) };
}

/** A uniform turn token across the panel's lanes, when every tagged lane agrees. */
function uniformTurn(turns: string[]): string | undefined {
  if (turns.length === 0) return undefined;
  const first = turns[0];
  if (!first || first === "none") return undefined;
  return turns.every((t) => t === first) ? first : undefined;
}

/** Attach one lane's tags to the panel it belongs to, merging equal neighbours. */
function groupAdjacent(
  panels: LaneGroup[],
  lane: number,
  refs: string[],
  destinations: string[],
  symbol: string,
  turn: string,
  colour: string,
): void {
  const previous = panels.at(-1);
  if (
    previous &&
    joinKeys(previous.refs) === joinKeys(refs) &&
    joinKeys(previous.destinations) === joinKeys(destinations) &&
    previous.symbol === symbol &&
    previous.colour === colour
  ) {
    previous.lanes.push(lane);
    previous.turns.push(turn);
    return;
  }
  panels.push({
    lanes: [lane],
    destinations,
    refs,
    symbol,
    turns: [turn],
    colour,
  });
}

/** Per-lane values collected before the adjacent-equal grouping pass. */
interface LaneGroup {
  lanes: number[];
  refs: string[];
  destinations: string[];
  symbol: string;
  turns: string[];
  colour: string;
}

function joinKeys(values: string[]): string {
  return values.join(";");
}

/**
 * Build a gantry model from one way's OSM tags. `null` when the tags carry no
 * per-lane destinations at all, or when a `:lanes` value disagrees with the
 * lane count and the fallback — a half-parsed gantry would lie about where
 * the lanes point.
 */
export function parseLaneTags(tags: OsmLaneTags, fallbackLaneCount?: number): GantryModel | null {
  const laneCount = tags.lanes ?? fallbackLaneCount;
  if (!laneCount || laneCount < 1) return null;
  const destinationLanes = laneValues(splitLaneValues(tags.destinationLanes), laneCount);
  const destinationRefLanes = laneValues(splitLaneValues(tags.destinationRefLanes), laneCount);
  if (destinationLanes === undefined && destinationRefLanes === undefined) return null;
  if (
    (tags.destinationLanes !== undefined && destinationLanes === undefined) ||
    (tags.destinationRefLanes !== undefined && destinationRefLanes === undefined)
  ) {
    return null;
  }
  const turnLanes = laneValues(splitLaneValues(tags.turnLanes), laneCount);
  const symbolLanes = laneValues(splitLaneValues(tags.destinationSymbolLanes), laneCount);
  const colourLanes = laneValues(splitLaneValues(tags.destinationColourLanes), laneCount);

  const panels: GantryPanel[] = [];
  const groups: LaneGroup[] = [];
  for (let lane = 0; lane < laneCount; lane += 1) {
    const tagged = splitRefParts(splitParts(destinationRefLanes?.[lane] ?? ""));
    const destinations = union(splitParts(destinationLanes?.[lane] ?? ""), tagged.places);
    const refs = tagged.refs;
    if (destinations.length === 0 && refs.length === 0) continue;
    groupAdjacent(
      groups,
      lane,
      refs,
      destinations,
      symbolLanes?.[lane] ?? "",
      turnLanes?.[lane] ?? "",
      colourLanes?.[lane] ?? "",
    );
  }
  for (const group of groups) {
    const turn = uniformTurn(group.turns);
    panels.push({
      lanes: group.lanes,
      destinations: group.destinations,
      refs: group.refs,
      symbols: group.symbol ? [group.symbol] : [],
      ...(group.colour ? { colour: group.colour } : {}),
      ...(turn ? { turn } : {}),
      isExit: false,
    });
  }
  if (panels.length === 0) return null;
  return {
    laneCount,
    panels,
    activeLanes: [],
    ...(turnLanes ? { laneTurns: turnLanes } : {}),
    source: "osm",
  };
}

/**
 * Append (or mark) the exit panel: destination text from the ramp's
 * `destination`/`destination:ref`, else the engine sign; exit number from the
 * engine sign, else the ramp's `junction:ref`. When the gantry way's lane
 * count disagrees with the decision point's (a lane gain before or after the
 * way was tagged), the exit panel spans the single outermost lane on the
 * point's side, so the highlight never lands on a lane the drawn gantry
 * does not have.
 */
export function mergeExitPanel(
  model: GantryModel,
  point: JunctionDecisionPoint,
  rampTags?: OsmLaneTags,
): GantryModel {
  const exitNumber = point.sign?.exitNumbers?.[0] ?? rampTags?.junctionRef;
  const rampRefs = rampTags?.destinationRef
    ? splitRefParts(splitParts(rampTags.destinationRef))
    : undefined;
  const destinations = union(
    rampTags?.destination ? splitParts(rampTags.destination) : (point.sign?.exitToward ?? []),
    rampRefs?.places ?? [],
  );
  const refs = rampRefs ? rampRefs.refs : (point.sign?.exitBranches ?? []);
  // The engine's own lanes win whenever it sent them for this gantry. Without
  // them (a routing backend that omits `turn_lanes`), OSM's per-lane turn
  // arrows name the exit lanes; only if neither speaks does the outermost lane
  // on the exit's side stand in.
  const engineLanes =
    model.laneCount === point.laneCount && point.activeLanes.length > 0 ? point.activeLanes : null;
  const taggedLanes = lanesTurningToward(model.laneTurns, point.side);
  const panelLanes =
    engineLanes ??
    (taggedLanes.length > 0 ? taggedLanes : [point.side === "left" ? 0 : model.laneCount - 1]);
  const carried = model.panels.filter((panel) => !panel.isExit);
  // A gantry often already boards the exit lane on its own ("A 46 /
  // Neuss-Zentrum"). Marking that board as the exit keeps one board lit per
  // decision instead of two over the same lane.
  const existing = carried.findIndex((panel) => sameLanes(panel.lanes, panelLanes));
  const exitPanel: GantryPanel =
    existing >= 0
      ? {
          ...carried[existing],
          destinations: union(destinations, carried[existing].destinations),
          refs: union(refs, carried[existing].refs),
          isExit: true,
          ...(exitNumber ? { exitNumber } : {}),
        }
      : {
          lanes: panelLanes,
          destinations,
          refs,
          symbols: [],
          isExit: true,
          ...(exitNumber ? { exitNumber } : {}),
        };
  const panels =
    existing >= 0
      ? carried.map((panel, index) => (index === existing ? exitPanel : panel))
      : [...carried, exitPanel];
  return { ...model, panels, activeLanes: [...panelLanes] };
}

function sameLanes(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((lane, index) => lane === b[index]);
}

/** `first` then whatever `rest` adds, each value once. */
function union(first: string[], rest: string[]): string[] {
  return [...new Set([...first, ...rest])];
}

/**
 * Lanes whose OSM turn arrow leaves the carriageway on the exit's side.
 * `merge_to_*` is left out: that marks a lane drop, not a turn-off.
 */
function lanesTurningToward(laneTurns: string[] | undefined, side: "left" | "right"): number[] {
  if (!laneTurns) return [];
  const leaving =
    side === "left"
      ? ["left", "slight_left", "sharp_left"]
      : ["right", "slight_right", "sharp_right"];
  return laneTurns.flatMap((token, lane) => (leaving.includes(token.trim()) ? [lane] : []));
}

/** Keep approach ways heading the same way as the route, upstream of the point. */
export function selectApproachWay(
  ways: JunctionWay[],
  point: JunctionDecisionPoint,
): JunctionWay | null {
  const candidates = ways.filter(
    (candidate) =>
      angularDifference(candidate.bearing, point.approachBearing) <= 35 &&
      candidate.endDistanceMeters >= 0 &&
      candidate.endDistanceMeters <= 450,
  );
  if (candidates.length === 0) return null;
  // A way whose lane count matches the decision point is the gantry in use;
  // prefer it over a parallel carriageway or a differently-tagged neighbour.
  const laneMatch = candidates.filter(
    (candidate) =>
      candidate.tags.lanes !== undefined &&
      point.laneCount !== undefined &&
      candidate.tags.lanes === point.laneCount,
  );
  const pool = laneMatch.length > 0 ? laneMatch : candidates;
  return pool.reduce((best, candidate) =>
    candidate.endDistanceMeters < best.endDistanceMeters ? candidate : best,
  );
}

/** How far from the decision point a ramp may begin and still be this exit's ramp. */
const RAMP_START_MAX_METERS = 60;

/**
 * The ramps (`_link` ways) leaving this split: they begin at the decision
 * point and head within 60° of the ramp direction, nearest start first. An
 * on-ramp merging just upstream also heads the route's way but starts far
 * from the point, so the start distance is what tells them apart.
 */
export function selectRampWay(ramps: JunctionWay[], point: JunctionDecisionPoint): JunctionWay[] {
  // The ramp's own heading is the approach bearing plus the signed divergence.
  const afterBearing = normalizeBearing(point.approachBearing + point.divergenceDeg);
  return ramps
    .filter(
      (ramp) =>
        ramp.highway.includes("_link") &&
        ramp.startDistanceMeters <= RAMP_START_MAX_METERS &&
        angularDifference(ramp.bearing, afterBearing) <= 60,
    )
    .sort((a, b) => a.startDistanceMeters - b.startDistanceMeters);
}

function normalizeBearing(bearing: number): number {
  return ((bearing % 360) + 360) % 360;
}
