import type {
  JunctionDecisionPoint,
  JunctionLookupResult,
  JunctionWay,
  LaneDestinations,
  OsmLaneTags,
} from "../types/junction";
import { angularDifference } from "./bearing";
import { type ResolvedLaneGuidance, resolveLaneGuidance } from "./lanes";
import { prepareRouteMatcher, snapPreparedRoute } from "./routeMatcher";
import { cleanSignTexts, refKind, signHeadline } from "./signFormat";

export interface ApproachLaneGuidance extends ResolvedLaneGuidance {
  source: "engine" | "osm";
}

function splitLaneValues(raw: string | undefined): string[] | undefined {
  return raw?.split("|").map((value) => value.trim());
}
function laneValues(values: string[] | undefined, count: number): string[] | undefined {
  return values?.length === count ? values : undefined;
}
function splitParts(value: string): string[] {
  return cleanSignTexts(value.split(";"));
}
function splitRefParts(values: string[]): { refs: string[]; places: string[] } {
  return {
    refs: values.filter((value) => refKind(value) !== "other"),
    places: values.filter((value) => refKind(value) === "other"),
  };
}
function union(first: string[], rest: string[]): string[] {
  return cleanSignTexts([...first, ...rest]);
}

/** Lane evidence for the green maneuver arrows, scoped to the incoming route occurrence. */
export function resolveApproachLaneGuidance(
  result: JunctionLookupResult,
  point: JunctionDecisionPoint,
): ApproachLaneGuidance | undefined {
  const approach =
    result.outgoingApproachWayId !== undefined
      ? result.approach.find((way) => way.wayId === result.outgoingApproachWayId)
      : selectApproachWay([...result.approach, ...result.ramps], point);
  const count = approach?.tags.lanes ?? point.laneCount;
  const engine = point.laneGuidance;
  const engineResult = engine
    ? {
        ...engine,
        ...(engine.state === "conflict"
          ? {
              lanes: engine.lanes.map((lane) => ({
                ...lane,
                valid: undefined,
                preferred: undefined,
                active: undefined,
              })),
              usableLanes: [],
              preferredLanes: [],
            }
          : {}),
        source: "engine" as const,
      }
    : undefined;
  if (
    !approach ||
    !count ||
    !Number.isInteger(count) ||
    count < 1 ||
    (point.approachTrace && !incomingLayoutMatches(point, approach, count))
  )
    return engineResult;
  const destinations = laneDestinationsAt(
    { approach: [approach], ramps: [] },
    { ...point, laneCount: count },
  );
  const turnValues = laneValues(splitLaneValues(approach.tags.turnLanes), count);
  const unknownLanes = Array.from({ length: count }, (_, i) => ({
    indications: (turnValues?.[i] ?? "").split(";").filter(Boolean),
  }));
  const ways = result.outgoing ?? [];
  const routeWay = ways.length >= 2 ? selectOutgoingBySign(ways, point) : undefined;
  const ramp = ways.length >= 2 ? routeWay : selectRampWay(result.ramps, point)[0];
  const labels =
    ramp && labelsAgree(ramp.tags, point)
      ? branchLabels(ramp)
      : { refs: point.sign?.exitBranches ?? [], destinations: signHeadline(point.sign) };
  const key = (value: string) => value.normalize("NFC").toLowerCase().replace(/\s/g, "");
  const wantedRefs = labels.refs.map(key);
  const wantedPlaces = labels.destinations.map(key);
  let selected =
    ways.length >= 2 && !routeWay
      ? []
      : (destinations ?? []).flatMap((lane, i) => {
          const refsMatch =
            !wantedRefs.length || lane.refs.some((ref) => wantedRefs.includes(key(ref)));
          const placesMatch =
            !wantedPlaces.length ||
            (wantedRefs.length > 0 && lane.destinations.length === 0) ||
            lane.destinations.some((place) => wantedPlaces.includes(key(place)));
          return refsMatch && placesMatch && (wantedRefs.length > 0 || wantedPlaces.length > 0)
            ? [i]
            : [];
        });
  // An outgoing subset cannot be inferred from a shared reference on every incoming lane.
  if (
    selected.length === count &&
    (ways.length >= 2 || (ramp?.tags.lanes !== undefined && ramp.tags.lanes < count))
  )
    selected = [];
  if (engine?.state === "conflict") return engineResult;
  if (point.laneCount === count && engine && engine.state !== "unknown") {
    const conflict =
      engine.state === "known" &&
      selected.length > 0 &&
      (engine.preferredLanes.some((i) => !selected.includes(i)) ||
        selected.some((i) => engine.lanes[i]?.valid === false)) &&
      engine.usableLanes.length > 0;
    return conflict
      ? { ...resolveLaneGuidance(unknownLanes), state: "conflict", source: "osm" }
      : engineResult;
  }
  if (!selected.length) return { ...resolveLaneGuidance(unknownLanes), source: "osm" };
  return {
    ...resolveLaneGuidance(
      unknownLanes.map((lane, i) => ({
        ...lane,
        valid: selected.includes(i),
        preferred: selected.includes(i),
      })),
    ),
    source: "osm",
  };
}

function labelsAgree(tags: OsmLaneTags, point: JunctionDecisionPoint): boolean {
  const key = (value: string) => value.toLowerCase().replace(/\s/g, "");
  const refs = point.sign?.exitBranches?.map(key) ?? [];
  const places = point.sign?.exitToward?.map(key) ?? [];
  const labels = branchLabels({ tags });
  return (
    (!refs.length || !labels.refs.length || labels.refs.some((ref) => refs.includes(key(ref)))) &&
    (!places.length ||
      !labels.destinations.length ||
      labels.destinations.some((place) => places.includes(key(place))))
  );
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

function branchLabels(way: Pick<JunctionWay, "tags">): { refs: string[]; destinations: string[] } {
  const refs = splitRefParts(splitParts(way.tags.destinationRef ?? ""));
  return {
    refs: refs.refs,
    destinations: union(splitParts(way.tags.destination ?? ""), refs.places),
  };
}

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

/** Keep approach ways heading the same way as the route, upstream of the point. */
export function selectApproachWay(
  ways: JunctionWay[],
  point: JunctionDecisionPoint,
): JunctionWay | null {
  const candidates = ways.filter(
    (candidate) =>
      angularDifference(candidate.bearing, point.approachBearing) <= 35 &&
      candidate.endDistanceMeters >= 0 &&
      candidate.endDistanceMeters <= 450 &&
      (!point.approachTrace || incomingLayoutMatches(point, candidate, candidate.tags.lanes ?? 0)),
  );
  if (candidates.length === 0) return null;
  // Prefer a compatible incoming layout;
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

/**
 * Where each of the route's lanes leads per OSM, read off the way carrying
 * them into the split. The approach may be a ramp:
 * a two-way split on a slip road happens on a `_link`. The way must head the
 * route's way, end at or before the point, and have exactly the engine's lane
 * count, so its `:lanes` values line up with the engine's lanes one to one.
 * `undefined` when no such way tags per-lane destinations.
 */
export function laneDestinationsAt(
  result: Pick<JunctionLookupResult, "approach" | "ramps">,
  point: JunctionDecisionPoint,
): LaneDestinations[] | undefined {
  const laneCount = point.laneCount;
  if (!laneCount) return undefined;
  const way = [...result.approach, ...result.ramps]
    .filter(
      (candidate) =>
        candidate.tags.lanes === laneCount &&
        angularDifference(candidate.bearing, point.approachBearing) <= 35 &&
        candidate.endDistanceMeters >= 0 &&
        candidate.endDistanceMeters <= 450 &&
        (!point.approachTrace ||
          incomingLayoutMatches(point, candidate, candidate.tags.lanes ?? 0)),
    )
    .sort((a, b) => a.endDistanceMeters - b.endDistanceMeters)[0];
  if (!way) return undefined;
  const destinationLanes = laneValues(splitLaneValues(way.tags.destinationLanes), laneCount);
  const destinationRefLanes = laneValues(splitLaneValues(way.tags.destinationRefLanes), laneCount);
  if (
    (way.tags.destinationLanes !== undefined && !destinationLanes) ||
    (way.tags.destinationRefLanes !== undefined && !destinationRefLanes) ||
    (!destinationLanes && !destinationRefLanes)
  )
    return undefined;
  return Array.from({ length: laneCount }, (_, lane) => {
    const tagged = splitRefParts(splitParts(destinationRefLanes?.[lane] ?? ""));
    return {
      destinations: union(splitParts(destinationLanes?.[lane] ?? ""), tagged.places),
      refs: tagged.refs,
    };
  });
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
