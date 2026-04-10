/**
 * RIS::Transports service — train occupancy data.
 *
 * Fetches occupancy levels for journeys from the RIS::Transports API
 * and maps them to the normalized OccupancyLevel used across the app.
 */

import type { OccupancyLevel } from "../transit/types.js";
import { isRisConfigured, risPost } from "./client.js";
import type { RisOccupancyLevel, RisOccupancyResponse } from "./transports-types.js";

function mapOccupancy(level: RisOccupancyLevel): OccupancyLevel {
  switch (level) {
    case "LOW":
      return "low";
    case "MIDDLE":
      return "medium";
    case "HIGH":
      return "high";
    case "OVERCROWDED":
      return "overcrowded";
  }
}

/**
 * Fetch occupancy levels for a batch of journey IDs.
 * Returns a map from raw journeyID → OccupancyLevel.
 * Uses economy class occupancy (most relevant for general users).
 */
export async function getJourneyOccupancy(
  journeyIds: string[],
): Promise<Map<string, OccupancyLevel>> {
  const result = new Map<string, OccupancyLevel>();
  if (!isRisConfigured() || journeyIds.length === 0) return result;

  try {
    const response = await risPost<RisOccupancyResponse>(
      "transports",
      "/occupancies",
      { journeyIDs: journeyIds.slice(0, 100) },
      6_000,
    );

    for (const entry of response.occupancies ?? []) {
      const level = entry.occupancy?.economy ?? entry.occupancy?.firstClass;
      if (level) {
        result.set(entry.journeyID, mapOccupancy(level));
      }
    }
  } catch {
    // Non-critical: occupancy is best-effort supplemental data
  }

  return result;
}
