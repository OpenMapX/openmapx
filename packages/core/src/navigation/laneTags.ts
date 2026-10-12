import type {
  GantryModel,
  GantryPanel,
  JunctionDecisionPoint,
  JunctionWay,
  OsmLaneTags,
} from "../types/junction";
import { angularDifference } from "./bearing";
import { prepareRouteMatcher, snapPreparedRoute } from "./routeMatcher";
import { cleanSignTexts, exitNumberLabel, refKind, signHeadline } from "./signFormat";

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
  return cleanSignTexts(value.split(";"));
}

/**
 * Separate road refs from place names found in a `destination:ref` value. A
 * road ref always carries a number ("A 46", "L 381", "M25"); a town never
 * does, so a digit-free value is a destination tagged into the wrong key.
 */
function splitRefParts(parts: string[]): { refs: string[]; places: string[] } {
  const hasNumber = (part: string) => /\d/.test(part);
  return {
    refs: cleanSignTexts(parts.filter(hasNumber), true),
    places: parts.filter((part) => !hasNumber(part)),
  };
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
    previous.lanes.at(-1) === lane - 1 &&
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
 * Keep the selected route separate from physical destination boards. Lane
 * assignments require engine evidence for this layout or matched per-lane
 * destinations identifying the selected branch. Geometry-bearing calls must
 * establish the incoming carriageway before using its OSM boards or indices.
 */
export function mergeExitPanel(
  model: GantryModel,
  point: JunctionDecisionPoint,
  rampTags?: OsmLaneTags,
  outgoing?: { ways: JunctionWay[]; approach?: JunctionWay },
): GantryModel {
  const layoutMatches = incomingLayoutMatches(point, outgoing?.approach, model.laneCount);
  if (point.approachTrace && !layoutMatches) {
    // Engine lanes belong to this route occurrence. An unmatched OSM way does
    // not establish its boards, lane indices or connected outgoing roads.
    const engineModel: GantryModel = {
      laneCount: point.laneCount ?? 0,
      panels: [],
      activeLanes: [],
      source: "engine",
      laneTurns: point.laneGuidance?.lanes.map((lane) => lane.indications.join(";")),
    };
    return {
      ...mergePrimaryExitPanel(engineModel, point),
      laneSelectionReliable: false,
      ...(outgoing?.approach ? { approachWay: outgoing.approach } : {}),
    };
  }
  const primaryModel = mergePrimaryExitPanel(model, point, rampTags);
  const attached: GantryModel = {
    ...primaryModel,
    laneSelectionReliable: primaryModel.laneSelectionReliable && layoutMatches,
    ...(outgoing?.approach ? { approachWay: outgoing.approach } : {}),
  };
  if (!outgoing || outgoing.ways.length < 2) return attached;
  const routeWay = selectOutgoingBySign(outgoing.ways, point);
  // A nearest link candidate is not route identity at a shared-node fork.
  // Fall back to the engine sign when no outgoing destination distinguishes it.
  const selected = mergePrimaryExitPanel(
    model,
    point,
    routeWay?.tags,
    routeWay ? "subset" : "none",
  );
  const merged = {
    ...selected,
    laneSelectionReliable: selected.laneSelectionReliable && layoutMatches,
    ...(outgoing.approach ? { approachWay: outgoing.approach } : {}),
  };
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

function incomingLayoutMatches(
  point: JunctionDecisionPoint,
  approach: JunctionWay | undefined,
  count: number,
): boolean {
  if (
    !approach?.geometry ||
    approach.geometry.length < 2 ||
    approach.tags.lanes !== count ||
    !point.approachTrace ||
    point.approachTrace.length < 2
  )
    return false;
  const matcher = prepareRouteMatcher(approach.geometry);
  const snaps = point.approachTrace
    .slice(-2)
    .map((coordinate) => snapPreparedRoute(matcher, coordinate));
  return snaps.every(
    (snap, i) =>
      snap.deviationMeters <= 8 && (i === 0 || snap.alongMeters > snaps[i - 1].alongMeters + 1),
  );
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
  const toward = signHeadline(point.sign).map(normalize);
  const refs = (point.sign?.exitBranches ?? []).map(normalize);
  const labeled = ways.map((way) => ({ way, ...branchLabels(way) }));
  if ((point.departureTrace?.length ?? 0) >= 2 && ways.some((way) => way.geometry)) {
    const matched = labeled.filter(({ way, refs: labels }) => {
      if (!way.geometry || way.geometry.length < 2) return false;
      if (refs.length && labels.length && !labels.some((ref) => refs.includes(normalize(ref))))
        return false;
      const matcher = prepareRouteMatcher(way.geometry);
      const snaps = point.departureTrace!.map((coordinate) =>
        snapPreparedRoute(matcher, coordinate),
      );
      return snaps.every(
        (snap, i) =>
          snap.deviationMeters <= 10 &&
          (i === 0 || snap.alongMeters > snaps[i - 1].alongMeters + 1),
      );
    });
    return matched.length === 1 ? matched[0].way : undefined;
  }
  const destinations = labeled.filter(
    (entry) =>
      entry.destinations.some((place) => toward.includes(normalize(place))) &&
      (refs.length === 0 ||
        entry.refs.length === 0 ||
        entry.refs.some((ref) => refs.includes(normalize(ref)))),
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
  destinationEvidence: "any" | "subset" | "none" = "any",
): GantryModel {
  if (rampTags && !labelsAgree(rampTags, point)) rampTags = undefined;
  const exitNumber =
    exitNumberLabel(point.sign?.exitNumbers?.[0]) ?? exitNumberLabel(rampTags?.junctionRef);
  const rampRefs = rampTags?.destinationRef
    ? splitRefParts(splitParts(rampTags.destinationRef))
    : undefined;
  const destinations = union(
    rampTags?.destination ? splitParts(rampTags.destination) : signHeadline(point.sign),
    rampRefs?.places ?? [],
  );
  const refs = rampRefs ? rampRefs.refs : (point.sign?.exitBranches ?? []);
  // A different lane count is a different layout: the engine's indices cannot
  // be shifted onto it. Opposite-side OSM arrows cannot resolve that mismatch.
  const engineLanes =
    model.laneCount === point.laneCount &&
    ((point.laneGuidance?.state !== undefined && point.laneGuidance.state !== "unknown") ||
      point.activeLanes.length > 0)
      ? point.activeLanes
      : null;
  // A shared ref cannot assign incoming lanes until the outgoing road is identified.
  const matchingLanes =
    destinationEvidence !== "none" ? lanesToDestination(model, refs, destinations) : [];
  const destinationLanes =
    matchingLanes.length === model.laneCount &&
    (destinationEvidence === "subset" ||
      (rampTags?.lanes !== undefined && rampTags.lanes < model.laneCount))
      ? []
      : matchingLanes;
  const conflict =
    point.laneGuidance?.state === "conflict" ||
    (engineLanes !== null &&
      destinationLanes.length > 0 &&
      point.laneGuidance?.state === "known" &&
      (point.laneGuidance.preferredLanes.some((lane) => !destinationLanes.includes(lane)) ||
        destinationLanes.some((lane) => point.laneGuidance?.lanes[lane]?.valid === false)));
  const panelLanes = conflict ? [] : (engineLanes ?? destinationLanes);
  const laneEvidence: GantryModel["laneEvidence"] = conflict
    ? "conflict"
    : engineLanes !== null
      ? "engine"
      : destinationLanes.length
        ? "osm-destination"
        : "unknown";
  const guidance = conflict
    ? {
        lanes: model.laneTurns?.map((turn) => ({ indications: turn.split(";") })) ?? [],
        preferredLanes: [],
        usableLanes: [],
        state: "conflict" as const,
      }
    : engineLanes !== null && point.laneGuidance
      ? point.laneGuidance
      : {
          lanes: Array.from({ length: model.laneCount }, (_, i) => ({
            indications: (model.laneTurns?.[i] ?? "").split(";"),
            ...(destinationLanes.length
              ? { valid: destinationLanes.includes(i), preferred: destinationLanes.includes(i) }
              : {}),
          })),
          preferredLanes: destinationLanes,
          usableLanes: destinationLanes,
          state: destinationLanes.length ? ("known" as const) : ("unknown" as const),
        };
  const laneSelectionReliable =
    panelLanes.length > 0 && guidance.state === "known" && guidance.preferredLanes.length > 0;
  const selectedRoute = {
    refs: cleanSignTexts(point.sign?.exitBranches ?? [], true).length
      ? cleanSignTexts(point.sign?.exitBranches ?? [], true)
      : refs,
    destinations: signHeadline(point.sign).length ? signHeadline(point.sign) : destinations,
    ...(exitNumber ? { exitNumber } : {}),
    turn: point.direction,
  };
  if (!selectedRoute.refs.length && !selectedRoute.destinations.length) {
    const roadNames = cleanSignTexts(point.roadNames ?? []);
    selectedRoute.refs = roadNames.filter((name) => refKind(name) !== "other");
    selectedRoute.destinations = roadNames.filter((name) => refKind(name) === "other");
  }
  const resolved = { laneGuidance: guidance, selectedRoute, laneEvidence };
  const carried = model.panels.filter((panel) => !panel.isExit);
  if (destinations.length === 0 && refs.length === 0 && !exitNumber) {
    return {
      ...model,
      ...resolved,
      panels: carried,
      activeLanes: [...panelLanes],
      laneSelectionReliable,
    };
  }
  // A gantry often already boards the exit lane on its own ("A 46 /
  // Neuss-Zentrum"). Marking that board as the exit keeps one board lit per
  // decision instead of two over the same lane.
  const existing = panelLanes.length
    ? carried.findIndex((panel) => panelLanes.every((lane) => panel.lanes.includes(lane)))
    : -1;
  const exitPanel: GantryPanel =
    existing >= 0
      ? {
          ...carried[existing],
          isExit: true,
          ...(exitNumber ? { exitNumber } : {}),
        }
      : {
          lanes: [],
          destinations,
          refs,
          symbols: [],
          isExit: true,
          ...(exitNumber ? { exitNumber } : {}),
        };
  const panels =
    existing >= 0
      ? carried.map((panel, index) => (index === existing ? exitPanel : panel))
      : carried.length > 0
        ? carried
        : [exitPanel];
  return {
    ...model,
    ...resolved,
    panels,
    activeLanes: [...panelLanes],
    laneSelectionReliable,
  };
}

function labelsAgree(tags: OsmLaneTags, point: JunctionDecisionPoint): boolean {
  const key = (value: string) => value.toLocaleLowerCase().replace(/\s/g, "");
  const refs = point.sign?.exitBranches?.map(key) ?? [];
  const places = point.sign?.exitToward?.map(key) ?? [];
  const labeled = splitRefParts(splitParts(tags.destinationRef ?? ""));
  const targets = splitParts(tags.destination ?? "");
  return (
    (!refs.length || !labeled.refs.length || labeled.refs.some((ref) => refs.includes(key(ref)))) &&
    (!places.length || !targets.length || targets.some((place) => places.includes(key(place))))
  );
}

/** `first` then whatever `rest` adds, each value once. */
function union(first: string[], rest: string[]): string[] {
  return cleanSignTexts([...first, ...rest]);
}

function lanesToDestination(model: GantryModel, refs: string[], destinations: string[]): number[] {
  const key = (value: string) => value.toLocaleLowerCase().replace(/\s/g, "");
  const wantedRefs = refs.map(key);
  const wantedPlaces = destinations.map(key);
  const lanes = model.panels.flatMap((panel) => {
    const refMatch =
      !wantedRefs.length || panel.refs.some((value) => wantedRefs.includes(key(value)));
    const placeMatch =
      !wantedPlaces.length ||
      (wantedRefs.length > 0 && panel.destinations.length === 0) ||
      panel.destinations.some((value) => wantedPlaces.includes(key(value)));
    return refMatch && placeMatch && (wantedRefs.length > 0 || wantedPlaces.length > 0)
      ? panel.lanes
      : [];
  });
  return [...new Set(lanes)];
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
