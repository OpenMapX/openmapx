/**
 * Raw API types for RIS::Transports v3 — occupancy data.
 * Internal only; consumers use the mapped OccupancyLevel type.
 */

export interface RisOccupancyRequest {
  journeyIDs: string[];
}

export type RisOccupancyLevel = "LOW" | "MIDDLE" | "HIGH" | "OVERCROWDED";

export interface RisOccupancyEntry {
  journeyID: string;
  occupancy?: {
    firstClass?: RisOccupancyLevel;
    economy?: RisOccupancyLevel;
  };
}

export interface RisOccupancyResponse {
  occupancies: RisOccupancyEntry[];
}
