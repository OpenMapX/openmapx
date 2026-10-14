import type { Attribution } from "./attribution.js";

/** The OpenConditions `vms` feature types: how a sign shows its messages. */
export type MessageSignType =
  | "textual"
  | "pictogram"
  | "matrix"
  | "lane_control"
  | "hybrid"
  | "arrow_board"
  | "flashing_beacon"
  | "other";

/** The OpenConditions `vms_working_status` vocabulary. */
export type MessageSignStatus = "in_service" | "out_of_service" | "fault" | "blank" | "unknown";

/** A dynamic message sign beside a road and what it shows now. */
export interface MessageSign {
  id: string;
  name: string;
  type: MessageSignType;
  country?: string;
  coordinates: [number, number];
  /** Where the sign stands, as its publisher describes it (e.g. "I-87 N at MP 6.1"). */
  location?: string;
  road?: string;
  /** The compass direction of the traffic the sign faces. */
  direction?: "N" | "NE" | "E" | "SE" | "S" | "SW" | "W" | "NW";
  operator?: { name: string };
  status: MessageSignStatus;
  /** The message's pages, each its lines top to bottom; empty for a blank sign. */
  pages: string[][];
  /** When the sign last changed, as an ISO 8601 timestamp. */
  updatedAt?: string;
  sources: string[];
  attributions: Attribution[];
}
