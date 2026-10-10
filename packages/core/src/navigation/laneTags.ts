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
 * Lane geometry does not require destination panels. Malformed destination
 * lists are withheld while a known lane count and valid turn arrows survive.
 * `null` means neither OSM nor the engine supplied a usable lane count.
 */
export function parseLaneTags(tags: OsmLaneTags, fallbackLaneCount?: number): GantryModel | null {
  const laneCount = tags.lanes ?? fallbackLaneCount;
  if (laneCount === undefined || !Number.isInteger(laneCount) || laneCount < 1) return null;
  let destinationLanes = laneValues(splitLaneValues(tags.destinationLanes), laneCount);
  let destinationRefLanes = laneValues(splitLaneValues(tags.destinationRefLanes), laneCount);
  const malformedDestinations =
    (tags.destinationLanes !== undefined && destinationLanes === undefined) ||
    (tags.destinationRefLanes !== undefined && destinationRefLanes === undefined);
  if (malformedDestinations) {
    destinationLanes = undefined;
    destinationRefLanes = undefined;
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
 * engine sign, else the ramp's `junction:ref`. Lane assignments require engine
 * lanes for this lane count, or OSM arrows agreeing with the maneuver side.
 * Unknown assignments retain the sign without lighting an inferred lane.
 */
export function mergeExitPanel(
  model: GantryModel,
  point: JunctionDecisionPoint,
  rampTags?: OsmLaneTags,
  outgoing?: { ways: JunctionWay[] },
): GantryModel {
  if (!outgoing || outgoing.ways.length < 2) return mergePrimaryExitPanel(model, point, rampTags);
  const routeWay = selectOutgoingBySign(outgoing.ways, point);
  // A nearest link candidate is not route identity at a shared-node fork.
  // Fall back to the engine sign when no outgoing destination distinguishes it.
  const merged = mergePrimaryExitPanel(model, point, routeWay?.tags);
  const primary = merged.panels.find((panel) => panel.isExit);
  const offset = (bearing: number) => ((bearing - point.approachBearing + 540) % 360) - 180;
  const ways = [...outgoing.ways].sort(
    (a, b) => offset(a.bearing) - offset(b.bearing) || a.wayId - b.wayId,
  );
  const panels: GantryPanel[] = ways.flatMap((way) => {
    const labels = branchLabels(way);
    const selected = way.wayId === routeWay?.wayId;
    const destinations =
      labels.destinations.length > 0
        ? labels.destinations
        : selected
          ? (primary?.destinations ?? [])
          : [];
    const refs = labels.refs.length > 0 ? labels.refs : selected ? (primary?.refs ?? []) : [];
    if (destinations.length === 0 && refs.length === 0 && !(selected && primary?.exitNumber))
      return [];
    return [
      {
        branchWayId: way.wayId,
        lanes: [],
        destinations,
        refs,
        symbols: splitParts(way.tags.destinationSymbol ?? ""),
        isExit: selected,
        ...(selected && primary?.exitNumber ? { exitNumber: primary.exitNumber } : {}),
      },
    ];
  });
  const branches = ways.map((way) => {
    const panel = panels.find((entry) => entry.branchWayId === way.wayId);
    const count = way.tags.lanes;
    return {
      wayId: way.wayId,
      bearing: way.bearing,
      ...(count !== undefined && Number.isInteger(count) && count > 0 ? { laneCount: count } : {}),
      selected: way.wayId === routeWay?.wayId,
      refs: panel?.refs ?? [],
      destinations: panel?.destinations ?? [],
    };
  });
  // Actual per-lane boards retain their layout; outgoing labels also travel
  // with the branch model for accessibility without implying lane assignments.
  if (model.panels.length > 0) return { ...merged, branches };
  if (!routeWay && primary) panels.push(primary);
  return { ...merged, branches, panels: panels.length > 0 ? panels : merged.panels };
}

function branchLabels(way: JunctionWay): { refs: string[]; destinations: string[] } {
  const refs = splitRefParts(splitParts(way.tags.destinationRef ?? ""));
  return {
    refs: refs.refs,
    destinations: union(splitParts(way.tags.destination ?? ""), refs.places),
  };
}

/** Destination text can distinguish branches sharing the same road ref. */
function selectOutgoingBySign(
  ways: JunctionWay[],
  point: JunctionDecisionPoint,
): JunctionWay | undefined {
  const normalize = (value: string) => value.toLocaleLowerCase().replace(/\s+/g, "");
  const toward = (point.sign?.exitToward ?? []).map(normalize);
  const refs = (point.sign?.exitBranches ?? []).map(normalize);
  const labeled = ways.map((way) => ({ way, ...branchLabels(way) }));
  const destinations = labeled.filter((entry) =>
    entry.destinations.some((place) => toward.includes(normalize(place))),
  );
  if (destinations.length > 0) return destinations.length === 1 ? destinations[0].way : undefined;
  // A reference alone may identify a destination-less road, but cannot override
  // an explicit, different destination or resolve two same-ref roads.
  const references = labeled.filter(
    (entry) =>
      (toward.length === 0 || entry.destinations.length === 0) &&
      entry.refs.some((ref) => refs.includes(normalize(ref))),
  );
  return references.length === 1 ? references[0].way : undefined;
}

function mergePrimaryExitPanel(
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
  // A different lane count is a different layout: the engine's indices cannot
  // be shifted onto it. Opposite-side OSM arrows cannot resolve that mismatch.
  const engineLanes =
    model.laneCount === point.laneCount && point.activeLanes.length > 0 ? point.activeLanes : null;
  const taggedLanes = lanesTurningToward(model.laneTurns, point.side);
  const panelLanes = engineLanes ?? taggedLanes;
  const carried = model.panels.filter((panel) => !panel.isExit);
  if (destinations.length === 0 && refs.length === 0 && !exitNumber) {
    return { ...model, panels: carried, activeLanes: [...panelLanes] };
  }
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
  return laneTurns.flatMap((token, lane) =>
    splitParts(token).some((part) => leaving.includes(part)) ? [lane] : [],
  );
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
