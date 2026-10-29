import type { Attribution } from "./attribution.js";

/** The OpenConditions `vehicle_activity` vocabulary: what a service vehicle is doing. */
export type ServiceVehicleActivity =
  | "plowing"
  | "salting"
  | "sanding"
  | "deadheading"
  | "idle"
  | "responding"
  | "unknown";

/**
 * A road service vehicle (a snowplough, a spreader, a maintenance truck)
 * where it last reported. Its publisher names no vehicle: the position is
 * anonymous, its id changes as the vehicle reports again, and it stands only
 * until it expires or the vehicle's next position replaces it.
 */
export interface ServiceVehicle {
  id: string;
  coordinates: [number, number];
  /**
   * Where the vehicle has just been, oldest first and ending at
   * `coordinates`: at most the last ten minutes of the current task.
   */
  trail?: [number, number][];
  /** The heading, in degrees clockwise from north. */
  bearingDeg?: number;
  activity?: ServiceVehicleActivity;
  /** The plough blade is down. */
  plowDown?: boolean;
  /** The spreader is spreading salt or sand. */
  spreaderOn?: boolean;
  /** The publisher's codes of the tasks the vehicle reports, verbatim. */
  tasks: string[];
  /** When the vehicle reported this position, as an ISO 8601 timestamp. */
  observedAt: string;
  /** When the position stops standing for the vehicle, as an ISO 8601 timestamp. */
  expiresAt?: string;
  sources: string[];
  attributions: Attribution[];
}
