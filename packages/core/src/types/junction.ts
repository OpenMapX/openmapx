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
  alongMeters: number;
  /** Route bearing ~100 m before the point, from geometry (not from the engine). */
  approachBearing: number;
  /** Signed ramp divergence: bearingAfter − bearingBefore normalised to (−180, 180]; geometry fallback. */
  divergenceDeg: number;
  laneCount?: number;
  /** 0-based indices of lanes the engine marks valid/active (after resolveRecommendedLanes). */
  activeLanes: number[];
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
  /** Tagged approach ways that can be drawn as a gantry. */
  approach: JunctionWay[];
  /** Tagged ramps leaving the split. */
  ramps: JunctionWay[];
  /**
   * Whether a motorway or trunk carriageway (not a link) runs through the
   * decision point in the route's direction, tagged or not. This is what
   * separates an exit from an on-ramp's surface street.
   */
  onMotorway: boolean;
  /**
   * Metres before the decision point from which the carriageway carries the
   * lane count it has at the split, i.e. where the exit lanes already exist.
   * Absent when OSM has no `lanes` on the way at the split.
   */
  fullLanesFromMeters?: number;
  /**
   * OSM could not be reached for this point, so the empty arrays are no
   * answer: the caller asks again later rather than treating the junction as
   * having no gantry and no motorway through it.
   */
  unavailable?: true;
}

export interface GantryPanel {
  /** 0-based lane indices this panel spans (left to right). */
  lanes: number[];
  destinations: string[];
  refs: string[];
  symbols: string[];
  colour?: string;
  /** turn:lanes token when uniform across the panel's lanes. */
  turn?: string;
  exitNumber?: string;
  isExit: boolean;
}

export interface GantryModel {
  laneCount: number;
  panels: GantryPanel[];
  activeLanes: number[];
  /** Raw OSM `turn:lanes` token per lane, left to right, when the way carries them. */
  laneTurns?: string[];
  /** "osm" when built from way tags; "engine" when only the engine sign was available. */
  source: "osm" | "engine";
}

export interface JunctionSchematic {
  width: number;
  height: number;
  laneCount: number;
  activeLanes: number[];
  side: "left" | "right";
  divergenceDeg: number;
  /** SVG path data for the through carriageway and the ramp, in a 320×140 viewBox. */
  throughPath: string;
  rampPath: string;
  /** One polygon per lane (trapezoids under perspective), left to right. */
  lanePolygons: string[];
  /** Where each panel's label sits (x centre, y) in viewBox units. */
  panelAnchors: Array<{ x: number; y: number }>;
}
