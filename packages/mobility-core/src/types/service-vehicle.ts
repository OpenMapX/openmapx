import type { Attribution } from "./attribution.js";

/** The OpenConditions `vehicle_activity` vocabulary: what a service vehicle is doing. */
export type ServiceVehicleActivity =
  | "plowing"
  | "salting"
  | "deadheading"
  | "idle"
  | "responding"
  | "unknown";

/**
 * A road service vehicle (a snowplough, a spreader, a maintenance truck)
 * where it last reported. Its publisher names no vehicle: the position is
 * anonymous and stands only until it expires.
 */
export interface ServiceVehicle {
  id: string;
  coordinates: [number, number];
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
