import type { JunctionLookupPoint, JunctionLookupResult } from "../types/junction";
import { apiClient } from "./client";
import { API_ENDPOINTS } from "./endpoints";

/**
 * Client for `POST /api/integrations/routing/navigation/junctions` — the
 * per-lane gantry tags behind the junction view. One request per batch (≤ 40
 * points).
 */

/**
 * Fetch the gantry ways for decision points; `null` when the request failed,
 * so the caller can ask again instead of settling on an empty answer.
 */
export async function fetchJunctionLookups(
  points: JunctionLookupPoint[],
): Promise<JunctionLookupResult[] | null> {
  try {
    const res = await apiClient.post<{ junctions: JunctionLookupResult[] }>(
      API_ENDPOINTS.navigationJunctions,
      { points },
    );
    return res.junctions ?? null;
  } catch {
    return null;
  }
}
