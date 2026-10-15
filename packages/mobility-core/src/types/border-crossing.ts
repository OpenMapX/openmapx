import type { Attribution } from "./attribution.js";

/** Who a queue at a border crossing is for: the OpenConditions `border_mode` vocabulary. */
export type BorderCrossingMode = "commercial" | "passenger" | "pedestrian" | "bus" | "rail";

/** Which lanes of a mode a queue uses: the OpenConditions `border_program` vocabulary. */
export type BorderCrossingProgram = "standard" | "fast" | "trusted_traveller" | "ready_lane";

/** The OpenConditions `border_wait_status` vocabulary. */
export type BorderWaitStatus = "no_delay" | "delay" | "closed" | "unknown";

/** One queue of a crossing in one direction and how long it is now. */
export interface BorderCrossingQueue {
  /** Unique within the crossing. */
  key: string;
  mode: BorderCrossingMode;
  program?: BorderCrossingProgram;
  /** The ISO 3166-1 country the queue leaves. */
  from?: string;
  /** The ISO 3166-1 country the queue enters. */
  to?: string;
  status: BorderWaitStatus;
  /** The wait, in minutes, when the publisher states one. */
  waitMinutes?: number;
  lanesOpen?: number;
  /** When the wait was stated, as an ISO 8601 timestamp. */
  updatedAt?: string;
  /** True when the wait is older than it stays current, or none is known. */
  stale: boolean;
}

/** A land border crossing and how long its queues are. */
export interface BorderCrossing {
  id: string;
  name: string;
  coordinates: [number, number];
  /** The two countries the crossing joins, as ISO 3166-1 codes. */
  countries: string[];
  /** The places either side, as the publisher describes them (e.g. "Fort Erie, ON/Buffalo, NY"). */
  location?: string;
  /** Whether a publisher states the crossing open or closed now. */
  open?: "open" | "closed";
  /** OSM-format opening hours, when a publisher states them. */
  openingHours?: string;
  queues: BorderCrossingQueue[];
  sources: string[];
  attributions: Attribution[];
}
