import type { LandmarkCandidate } from "../navigation/landmarks";
import { type ApiClient, apiClient } from "./client";
import { API_ENDPOINTS } from "./endpoints";

/** One manoeuvre point's answer; `unavailable` means Overpass could not answer for it. */
export interface NavigationLandmarkResult {
  candidates: LandmarkCandidate[];
  unavailable?: true;
}

/**
 * Client for `POST /api/integrations/routing/navigation/landmarks`: landmark
 * candidates near up to 40 manoeuvre points, aligned to `points`. `null` on any
 * failure, including an answer whose length does not match the request.
 */
export async function fetchNavigationLandmarks(
  points: { lat: number; lon: number }[],
  options: { client?: ApiClient; signal?: AbortSignal } = {},
): Promise<NavigationLandmarkResult[] | null> {
  try {
    const client = options.client ?? apiClient;
    const response = await client.post<{ results?: NavigationLandmarkResult[] }>(
      API_ENDPOINTS.navigationLandmarks,
      { points },
      options.signal ? { signal: options.signal } : {},
    );
    const results = response?.results;
    return Array.isArray(results) && results.length === points.length ? results : null;
  } catch {
    return null;
  }
}
