import type { TripItinerary } from "@openmapx/mobility-core/transit";
import type { ScheduleFidelity, TripSchedule } from "./routing";

/** Why a chained transit plan is less than the caller asked for. */
export type ChainPlanWarning =
  /** A segment's realtime arrival lands after the next segment departs. */
  | { kind: "missed-connection"; afterSegmentIndex: number; overlapSeconds: number }
  /** Some leg of a chosen itinerary is cancelled. */
  | { kind: "cancelled-leg"; segmentIndex: number }
  /** The provider could not honour a hard requirement it was asked for. */
  | { kind: "unmet-requirement"; segmentIndex: number; requirements: string[] }
  /** No itinerary exists for this segment; the chain stops here. */
  | { kind: "no-connection"; segmentIndex: number };

/** One origin-to-destination hop of a chained transit trip. */
export interface ChainedTripSegment {
  fromIndex: number;
  toIndex: number;
  itinerary: TripItinerary;
  /** Other itineraries for this segment, for the earlier/later affordance. */
  alternatives: TripItinerary[];
  /**
   * Seconds between the moment the traveller was free to leave and the moment
   * the chosen service actually departs. Kept separate from travel time so the
   * timeline can say "leave at 09:00, the train goes at 09:17".
   */
  boardingWaitSeconds: number;
  /** Realtime arrival minus scheduled arrival, in seconds. Zero when unknown. */
  delaySeconds: number;
}

/** A multi-stop transit trip planned around per-waypoint constraints. */
export interface ChainedTripPlan {
  segments: ChainedTripSegment[];
  schedule: TripSchedule;
  fidelity: ScheduleFidelity;
  warnings: ChainPlanWarning[];
  provider?: string;
}
