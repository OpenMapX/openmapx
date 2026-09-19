import type { StreetLevelImage, StreetLevelSearchQuery } from "../types/streetLevel";
import { apiClient } from "./client";

/**
 * Client for the street-level-imagery `/search` routes (navigation photo
 * prefetch). Returns [] on any error — the junction panel falls back to the
 * schematic, and navigation must never fail over a photo.
 */
export async function searchStreetLevelImages(
  providerId: string,
  query: StreetLevelSearchQuery,
): Promise<StreetLevelImage[]> {
  const params: Record<string, string> = {
    lng: String(query.lngLat[0]),
    lat: String(query.lngLat[1]),
    radius: String(query.radiusM),
  };
  if (query.heading !== undefined) params.heading = String(query.heading);
  if (query.headingToleranceDeg !== undefined) {
    params.headingTolerance = String(query.headingToleranceDeg);
  }
  if (query.capturedAfter) params.after = query.capturedAfter;
  if (query.lookingAt) {
    params.lookAtLng = String(query.lookingAt[0]);
    params.lookAtLat = String(query.lookingAt[1]);
  }
  if (query.limit) params.limit = String(query.limit);
  try {
    const res = await apiClient.get<StreetLevelImage[]>(
      `/api/integrations/street-level-imagery-${encodeURIComponent(providerId)}/search`,
      params,
    );
    return res ?? [];
  } catch {
    return [];
  }
}
