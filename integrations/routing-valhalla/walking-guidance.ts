/**
 * Walking guidance from Valhalla's pedestrian maneuvers.
 *
 * Where sidewalks and paths across squares are mapped as their own unnamed
 * ways, Valhalla narrates nearly every step as "onto the walkway", and each hop
 * onto a crosswalk and back becomes two turns a few metres apart. This rewrites
 * a walking leg's steps so they say something a walker can act on:
 *
 * - a crosswalk becomes one step that names the street it crosses, when a
 *   street runs through its middle ("Cross Spandauer Straße");
 * - a jog shorter than {@link JOG_M} folds into the step before, and the turn
 *   after it is re-derived from the heading before the jog;
 * - an unnamed stretch of {@link NAME_MIN_M} or more borrows the street it runs
 *   beside (the caller looks both up, see {@link nameLookups});
 * - a turn that keeps to the same street says so ("to stay on …");
 * - the text is composed from the turn and the street in the user's language,
 *   with the same strings transit walking legs use.
 *
 * Steps this does not understand (arrival, stairs, elevators, ferries) keep
 * Valhalla's own text.
 */

import { bearingBetween, haversineDistance, type LngLat, type RouteStep } from "@openmapx/core";
import { createTranslator } from "@openmapx/i18n";

/** The fields of a Valhalla maneuver this reads. */
export interface WalkManeuver {
  type: number;
  begin_shape_index: number;
  end_shape_index: number;
  street_names?: string[];
}

/** An edge from `trace_attributes` over the leg's own shape. */
export interface WalkEdge {
  use?: string;
  begin_shape_index?: number;
  end_shape_index?: number;
}

/** Shorter turns are jogs: onto a crosswalk, around a kerb, along a corner. */
export const JOG_M = 15;
/** Shorter unnamed stretches are not worth naming; longer ones borrow a nearby street. */
export const NAME_MIN_M = 30;
/** How far from a stretch a street may be to lend it its name. */
const NAME_RADIUS_M = 25;
/**
 * How far from a crosswalk's middle the street it crosses may be. Its
 * centreline runs through it, or beside an island between two carriageways.
 */
const CROSSED_RADIUS_M = 8;
/** A crosswalk starting this soon after a turn replaces that turn. */
const CROSS_AT_START_M = 15;
/** Crosswalks this close together (a traffic island between) are one crossing. */
const ISLAND_M = 10;
/** Shorter crosswalk runs are kerb ramps or mapping noise. */
const MIN_CROSSING_M = 3;
/** Distance over which a heading is measured, so one short segment cannot skew it. */
const HEADING_SPAN_M = 10;

type Modifier =
  | "straight"
  | "slight left"
  | "slight right"
  | "left"
  | "right"
  | "sharp left"
  | "sharp right"
  | "uturn";

interface Draft {
  kind: "depart" | "turn" | "continue" | "cross" | "fixed";
  modifier?: Modifier;
  /** The street walked along during this step; a crossing carries the street walked after it. */
  name?: string;
  /** A crossing's own shape range, and the street it crosses. */
  crossing?: [number, number];
  crossed?: string;
  begin: number;
  end: number;
  distance: number;
  duration: number;
  /** Heading arriving at this step, when a folded jog changed what the turn is relative to. */
  headingIn?: number;
  /** The step this came from; fixed steps are returned as they are. */
  step: RouteStep;
}

export interface WalkingLegPlan {
  drafts: Draft[];
  coordinates: LngLat[];
  /** Metres along the leg at each shape point. */
  along: number[];
}

const VALHALLA_TURNS: Record<number, Modifier> = {
  9: "slight right",
  10: "right",
  11: "sharp right",
  12: "uturn",
  13: "uturn",
  14: "sharp left",
  15: "left",
  16: "slight left",
  // A walker reads "keep right" at a fork as bearing right.
  23: "slight right",
  24: "slight left",
};
// kBecomes, kContinue, kStayStraight.
const VALHALLA_CONTINUES = new Set([7, 8, 22]);

const WALK_DIR_KEY: Record<Modifier, string> = {
  straight: "continue",
  "slight left": "slightLeft",
  "slight right": "slightRight",
  left: "left",
  right: "right",
  "sharp left": "sharpLeft",
  "sharp right": "sharpRight",
  uturn: "uturn",
};

const COMPASS = ["n", "ne", "e", "se", "s", "sw", "w", "nw"] as const;

function draftKind(type: number): Pick<Draft, "kind" | "modifier"> {
  if (type >= 1 && type <= 3) return { kind: "depart" };
  const modifier = VALHALLA_TURNS[type];
  if (modifier) return { kind: "turn", modifier };
  if (VALHALLA_CONTINUES.has(type)) return { kind: "continue", modifier: "straight" };
  return { kind: "fixed" };
}

/** Metres along the leg at each of its shape points. */
function alongDistances(coordinates: LngLat[]): number[] {
  const along = [0];
  for (let i = 1; i < coordinates.length; i++) {
    along.push(along[i - 1] + haversineDistance(coordinates[i - 1], coordinates[i]));
  }
  return along;
}

/** Index range of each crossing on the leg, with crosswalks across an island joined. */
function crossingRuns(edges: readonly WalkEdge[], along: number[]): Array<[number, number]> {
  const runs: Array<[number, number]> = [];
  const crossings = edges
    .filter(
      (edge) =>
        edge.use === "pedestrian_crossing" &&
        typeof edge.begin_shape_index === "number" &&
        typeof edge.end_shape_index === "number" &&
        edge.end_shape_index < along.length,
    )
    .map((edge) => [edge.begin_shape_index as number, edge.end_shape_index as number] as const)
    .sort((a, b) => a[0] - b[0]);
  for (const [begin, end] of crossings) {
    const last = runs.at(-1);
    if (last && along[begin] - along[last[1]] < ISLAND_M) last[1] = Math.max(last[1], end);
    else runs.push([begin, end]);
  }
  return runs.filter(([begin, end]) => along[end] - along[begin] >= MIN_CROSSING_M);
}

/** Splits `draft` at shape index `at`; the second part becomes the crossing. */
function splitAt(draft: Draft, at: number, along: number[]): [Draft, Draft] {
  const span = along[draft.end] - along[draft.begin];
  const share = span > 0 ? (along[at] - along[draft.begin]) / span : 0;
  return [
    {
      ...draft,
      end: at,
      distance: draft.distance * share,
      duration: draft.duration * share,
    },
    {
      ...draft,
      kind: "cross",
      modifier: undefined,
      headingIn: undefined,
      begin: at,
      distance: draft.distance * (1 - share),
      duration: draft.duration * (1 - share),
    },
  ];
}

function withCrossings(drafts: Draft[], runs: Array<[number, number]>, along: number[]): Draft[] {
  if (runs.length === 0) return drafts;
  const out: Draft[] = [];
  for (const draft of drafts) {
    if (draft.kind === "fixed") {
      out.push(draft);
      continue;
    }
    let current = draft;
    for (const [begin, end] of runs) {
      if (begin < current.begin || begin >= current.end) continue;
      const offset = along[begin] - along[current.begin];
      if (current.kind !== "depart" && offset < CROSS_AT_START_M) {
        current = { ...current, kind: "cross", modifier: undefined, crossing: [begin, end] };
      } else if (offset >= 1) {
        const [before, crossing] = splitAt(current, begin, along);
        out.push(before);
        current = { ...crossing, crossing: [begin, end] };
      }
    }
    out.push(current);
  }
  return out;
}

/** The shape point at least `span` metres before (−) or after (+) `index`. */
function pointAway(plan: Pick<WalkingLegPlan, "along">, index: number, span: number): number {
  const { along } = plan;
  let j = index;
  if (span < 0) while (j > 0 && along[index] - along[j] < -span) j--;
  else while (j < along.length - 1 && along[j] - along[index] < span) j++;
  return j;
}

function heading(plan: WalkingLegPlan, from: number, to: number): number | undefined {
  const a = plan.coordinates[from];
  const b = plan.coordinates[to];
  if (!a || !b || haversineDistance(a, b) < 0.5) return undefined;
  return bearingBetween(a, b);
}

const headingBefore = (plan: WalkingLegPlan, index: number) =>
  heading(plan, pointAway(plan, index, -HEADING_SPAN_M), index);
const headingAfter = (plan: WalkingLegPlan, index: number) =>
  heading(plan, index, pointAway(plan, index, HEADING_SPAN_M));

function modifierFor(from: number, to: number): Modifier {
  const delta = ((((to - from) % 360) + 540) % 360) - 180;
  const angle = Math.abs(delta);
  if (angle < 25) return "straight";
  const side = delta > 0 ? "right" : "left";
  if (angle < 60) return `slight ${side}`;
  if (angle < 135) return side;
  if (angle < 165) return `sharp ${side}`;
  return "uturn";
}

function absorb(into: Draft, draft: Draft): void {
  into.end = draft.end;
  into.distance += draft.distance;
  into.duration += draft.duration;
}

function foldJogs(plan: WalkingLegPlan): void {
  const { drafts } = plan;
  for (let i = 1; i < drafts.length; ) {
    const jog = drafts[i];
    const previous = drafts[i - 1];
    const isJog =
      (jog.kind === "turn" || jog.kind === "continue") &&
      jog.distance < JOG_M &&
      previous.kind !== "fixed";
    if (!isJog) {
      i++;
      continue;
    }
    absorb(previous, jog);
    const next = drafts[i + 1];
    if (next && (next.kind === "turn" || next.kind === "continue")) {
      const before = jog.headingIn ?? headingBefore(plan, jog.begin);
      const after = headingAfter(plan, next.begin);
      if (before !== undefined && after !== undefined) {
        const modifier = modifierFor(before, after);
        next.kind = modifier === "straight" ? "continue" : "turn";
        next.modifier = modifier;
        next.headingIn = before;
      }
    }
    drafts.splice(i, 1);
  }
}

/**
 * Restructures a walking leg: crossings, jogs. Names are added afterwards with
 * {@link nameStretches}, and the steps written with {@link composeWalkingSteps}.
 * `steps` are the leg's steps in maneuver order; `edges` may be missing when
 * the edge lookup failed, which only costs the crossings.
 */
export function planWalkingLeg(
  maneuvers: readonly WalkManeuver[],
  steps: readonly RouteStep[],
  coordinates: LngLat[],
  edges?: readonly WalkEdge[],
): WalkingLegPlan {
  const along = alongDistances(coordinates);
  const last = coordinates.length - 1;
  const initial: Draft[] = maneuvers.map((maneuver, i) => {
    const step = steps[i];
    return {
      ...draftKind(maneuver.type),
      name: maneuver.street_names?.[0],
      begin: Math.min(Math.max(maneuver.begin_shape_index, 0), last),
      end: Math.min(Math.max(maneuver.end_shape_index, 0), last),
      distance: step.distance,
      duration: step.duration,
      step,
    };
  });
  const plan: WalkingLegPlan = {
    drafts: withCrossings(initial, edges ? crossingRuns(edges, along) : [], along),
    coordinates,
    along,
  };
  foldJogs(plan);
  return plan;
}

function pointAt(plan: WalkingLegPlan, metres: number): LngLat {
  const { along, coordinates } = plan;
  let i = 1;
  while (i < along.length - 1 && along[i] < metres) i++;
  const a = coordinates[i - 1];
  const b = coordinates[i] ?? a;
  const span = along[i] - along[i - 1];
  const t = span > 0 ? Math.min(Math.max((metres - along[i - 1]) / span, 0), 1) : 0;
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

/** A street-name lookup: at `point`, the closest named street within `radius` metres. */
export interface NameLookup {
  index: number;
  /** `name` for the street a stretch runs beside, `crossed` for the street a crosswalk crosses. */
  field: "name" | "crossed";
  point: LngLat;
  radius: number;
}

/**
 * The street names worth looking up: the street each crosswalk crosses, and
 * the street beside each unnamed stretch long enough to need one.
 */
export function nameLookups(plan: WalkingLegPlan): NameLookup[] {
  const lookups: NameLookup[] = [];
  const middle = (begin: number, end: number) =>
    pointAt(plan, (plan.along[begin] + plan.along[end]) / 2);
  plan.drafts.forEach((draft, index) => {
    if (draft.kind === "cross") {
      // A crossing's middle lies on the street it crosses, so the street
      // walked on afterwards is the one before it (see nameStretches).
      if (draft.crossing) {
        const [begin, end] = draft.crossing;
        lookups.push({
          index,
          field: "crossed",
          point: middle(begin, end),
          radius: CROSSED_RADIUS_M,
        });
      }
      return;
    }
    if (draft.kind === "fixed" || draft.name || draft.distance < NAME_MIN_M) return;
    lookups.push({
      index,
      field: "name",
      point: middle(draft.begin, draft.end),
      radius: NAME_RADIUS_M,
    });
  });
  return lookups;
}

/** Applies looked-up street names, by draft index, then joins steps that only carry on. */
export function nameStretches(
  plan: WalkingLegPlan,
  names: ReadonlyArray<Pick<NameLookup, "index" | "field"> & { name: string | undefined }>,
): void {
  for (const { index, field, name } of names) {
    const draft = plan.drafts[index];
    if (draft && name && !draft[field]) draft[field] = name;
  }
  const { drafts } = plan;
  // Across a crossing the walker keeps to the street they were following, so
  // walking on along it afterwards is not a new street.
  for (let i = 1; i < drafts.length; i++) {
    if (drafts[i].kind === "cross" && !drafts[i].name) drafts[i].name = drafts[i - 1].name;
  }
  for (let i = 1; i < drafts.length; ) {
    const draft = drafts[i];
    const previous = drafts[i - 1];
    if (
      draft.kind === "continue" &&
      previous.kind !== "fixed" &&
      (!draft.name || draft.name === previous.name)
    ) {
      absorb(previous, draft);
      drafts.splice(i, 1);
    } else {
      i++;
    }
  }
}

/** An edge from Valhalla's `/locate`, verbose. */
export interface LocatedEdge {
  distance?: number;
  edge_info?: { names?: string[] } | null;
  edge?: { access?: { car?: boolean } } | null;
}

/**
 * The name of the closest named edge within the lookup's radius. A crossed
 * street must carry cars: a sidewalk named after the street alongside lies as
 * close to a crosswalk's middle as the street it crosses.
 */
export function nearestStreetName(
  edges: readonly LocatedEdge[] | null | undefined,
  lookup: Pick<NameLookup, "field" | "radius">,
): string | undefined {
  let best: { distance: number; name: string } | undefined;
  for (const edge of edges ?? []) {
    const name = edge.edge_info?.names?.find((candidate) => candidate.trim().length > 0);
    const distance = edge.distance;
    if (!name || typeof distance !== "number" || distance > lookup.radius) continue;
    if (lookup.field === "crossed" && edge.edge?.access?.car !== true) continue;
    if (!best || distance < best.distance) best = { distance, name };
  }
  return best?.name;
}

function compass(bearing: number): (typeof COMPASS)[number] {
  return COMPASS[Math.round((((bearing % 360) + 360) % 360) / 45) % 8];
}

/** Writes the leg's steps in `lang`, keeping steps this does not understand unchanged. */
export function composeWalkingSteps(plan: WalkingLegPlan, lang?: string): RouteStep[] {
  const t = createTranslator(lang, "navigation");
  let street: string | undefined;
  return plan.drafts.map((draft) => {
    if (draft.kind === "fixed") {
      street = draft.step.roadNames?.[0];
      return draft.step;
    }
    const bearingAfter = headingAfter(plan, draft.begin) ?? draft.step.bearingAfter;
    let instruction: string;
    let maneuver: NonNullable<RouteStep["maneuver"]>;
    if (draft.kind === "depart") {
      const direction = bearingAfter === undefined ? undefined : compass(bearingAfter);
      instruction = direction
        ? draft.name
          ? t("walkHeadOnStreet", { direction, street: draft.name })
          : t("walkHead", { direction })
        : draft.name
          ? t("walkOnStreet", { action: t("walkDir.depart"), street: draft.name })
          : t("walkDir.depart");
      maneuver = { type: "depart" };
    } else if (draft.kind === "cross") {
      instruction = draft.crossed
        ? t("walkCrossStreet", { street: draft.crossed })
        : t("walkDir.cross");
      maneuver = { type: "continue", modifier: "straight" };
    } else {
      const modifier = draft.modifier ?? "straight";
      const action = t(`walkDir.${WALK_DIR_KEY[modifier]}`);
      instruction = !draft.name
        ? action
        : draft.name === street
          ? t("walkStayOnStreet", { action, street: draft.name })
          : t("walkOnStreet", { action, street: draft.name });
      maneuver =
        modifier === "straight"
          ? { type: "continue", modifier: "straight" }
          : { type: "turn", modifier };
    }
    street = draft.kind === "cross" ? (draft.name ?? street) : draft.name;

    // Valhalla's voice phrasings still say "onto the walkway"; without them the
    // voice reads this instruction, with the distance prefixed per cue.
    const {
      verbalAlert: _alert,
      verbalPre: _pre,
      verbalPost: _post,
      verbalSuccinct: _succinct,
      lanes: _lanes,
      sign: _sign,
      roadNames: _roadNames,
      ...rest
    } = draft.step;
    const step: RouteStep = {
      ...rest,
      instruction,
      distance: draft.distance,
      duration: draft.duration,
      coordinates: plan.coordinates.slice(draft.begin, draft.end + 1),
      maneuver,
      bearingBefore: headingBefore(plan, draft.begin) ?? draft.step.bearingBefore,
      bearingAfter,
    };
    if (draft.name) step.roadNames = [draft.name];
    if (step.bearingBefore === undefined) delete step.bearingBefore;
    if (step.bearingAfter === undefined) delete step.bearingAfter;
    return step;
  });
}

/**
 * The street a walk follows furthest, for its "via" summary. Valhalla names
 * the first named maneuver, which on a sidewalk network can be a 5 m jog.
 */
export function longestStreet(steps: readonly RouteStep[]): string | undefined {
  const metres = new Map<string, number>();
  for (const step of steps) {
    const name = step.roadNames?.[0];
    if (name) metres.set(name, (metres.get(name) ?? 0) + step.distance);
  }
  let best: string | undefined;
  for (const [name, distance] of metres) {
    if (best === undefined || distance > (metres.get(best) ?? 0)) best = name;
  }
  return best;
}
