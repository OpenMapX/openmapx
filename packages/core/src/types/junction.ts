import type { ResolvedLaneGuidance } from "../navigation/lanes";
import type { LngLat } from "./geometry";
import type { ManeuverSign } from "./routing";

export type JunctionKind = "exit" | "fork";

/** A motorway decision point derived from the route alone. Pure, computed once per route. */
export interface JunctionDecisionPoint {
  /** Index of the step whose maneuver is the decision (the "upcoming" step in NavManeuverSlot terms). */
  stepIndex: number;
  kind: JunctionKind;
  side: "left" | "right";
  point: LngLat;
  /** Arc-length on route geometry in metres; engine-distance fallback when step coordinates are missing. */
  alongMeters: number;
  /** Route bearing ~100 m before the point, from geometry (not from the engine). */
  approachBearing: number;
  /** Signed ramp divergence: bearingAfter − bearingBefore normalised to (−180, 180]; geometry fallback. */
  divergenceDeg: number;
  laneCount?: number;
  /** Preferred lane indices when supplied, otherwise initially usable indices. */
  activeLanes: number[];
  laneGuidance?: ResolvedLaneGuidance;
  /** Ordered route samples after this occurrence, used to identify the connected branch. */
  departureTrace?: LngLat[];
  /** Ordered route samples on the incoming layout. */
  approachTrace?: LngLat[];
  sign?: ManeuverSign;
}

/** OSM lane/destination tags of one way, as returned by the junctions endpoint. */
export interface OsmLaneTags {
  lanes?: number;
  turnLanes?: string;
  destinationLanes?: string;
  destinationRefLanes?: string;
  destinationSymbolLanes?: string;
  destinationColourLanes?: string;
  destination?: string;
  destinationRef?: string;
  destinationSymbol?: string;
  destinationInt?: string;
  /** Exit number tagged on the ramp way itself, e.g. "20". */
  junctionRef?: string;
}

export interface JunctionWay {
  wayId: number;
  highway: string;
  ref?: string;
  name?: string;
  /** Forward travel bearing of the way at its end nearest the decision point, oneway-corrected. */
  bearing: number;
  /**
   * Metres from the way's travel-direction end node to the decision point.
   * Positive when that end lies upstream of the point (the way leads into it),
   * negative when the way starts at or after the point and runs away from it.
   */
  endDistanceMeters: number;
  /** Metres from the way's travel-direction start node to the decision point; a ramp leaving the split starts near 0. */
  startDistanceMeters: number;
  tags: OsmLaneTags;
  /** Bounded local shape in legal travel direction. */
  geometry?: LngLat[];
}

/** One decision point as sent to the junctions endpoint. */
export interface JunctionLookupPoint {
  lng: number;
  lat: number;
  /** Approach bearing, degrees clockwise from north. */
  bearing: number;
  /**
   * Route vertices sampled at 400, 250, 120 and 30 m upstream, the point itself
   * and 30 m downstream, oldest first. The server searches OSM around this
   * polyline, so a curved approach is followed instead of extrapolated along
   * the bearing.
   */
  trace: LngLat[];
}

export interface JunctionLookupResult {
  index: number;
  /** Approach ways carrying lane geometry or destination/turn tags. */
  approach: JunctionWay[];
  /** Tagged ramps leaving the split. */
  ramps: JunctionWay[];
  /** Roads whose travel start shares the selected approach's final OSM node. */
  outgoing?: JunctionWay[];
  /** Approach whose terminal node defines outgoing topology. */
  outgoingApproachWayId?: number;
  /**
   * Whether a motorway or trunk carriageway (not a link) runs through the
   * decision point in the route's direction, tagged or not. This is what
   * separates an exit from an on-ramp's surface street.
   */
  onMotorway: boolean;
  /**
   * OSM could not be reached for this point, so the empty arrays are no
   * answer: the caller asks again later rather than treating the junction as
   * having no lane evidence and no motorway through it.
   */
  unavailable?: true;
}

/** Where one lane leads, as its OSM `destination:lanes`/`destination:ref:lanes` name it. */
export interface LaneDestinations {
  destinations: string[];
  refs: string[];
}
