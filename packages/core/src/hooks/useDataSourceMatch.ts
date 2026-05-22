import type { DataSourceDetail, DataSourceResult } from "@openmapx/integration-framework";
import type { MobilityEnvelope } from "@openmapx/mobility-core/result";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../api/client";
import { API_ENDPOINTS } from "../api/endpoints";
import type { Place } from "../types/place";
import { haversineDistance } from "../utils/coordinates";

/**
 * Mapping from OSM raw category strings to data source IDs.
 * When a place has one of these raw categories and no `dataSourceDetail`,
 * we try to match it by searching the data source API for nearby items.
 */
const RAW_CATEGORY_TO_DATA_SOURCE: Record<string, string> = {
  charging_station: "ev-charging",
  "amenity/charging_station": "ev-charging",
  "car/charging_station": "ev-charging",
  "fuel/charging_station": "ev-charging",
  ev_charging: "ev-charging",
  fuel: "fuel",
  "amenity/fuel": "fuel",
  "car/fuel": "fuel",
  "fuel/fuel": "fuel",
  bicycle_rental: "bike-sharing",
  "amenity/bicycle_rental": "bike-sharing",
  bike_sharing: "bike-sharing",
  car_sharing: "car-sharing",
  "amenity/car_sharing": "car-sharing",
  scooter_sharing: "scooter-sharing",
  parking: "parking",
  parking_garage: "parking",
  parking_paid: "parking",
  "amenity/parking": "parking",
  "car/parking": "parking",
};

/** Maximum distance in metres for a match to be considered valid. */
const MAX_MATCH_DISTANCE = 100;

/**
 * Small bbox around a point for searching nearby data source items.
 * Delta ~0.002 degrees ≈ 220m at equator.
 */
const SEARCH_DELTA = 0.002;

function resolveDataSourceId(place: Place): string | null {
  if (place.rawCategory) {
    const fromRaw = RAW_CATEGORY_TO_DATA_SOURCE[place.rawCategory];
    if (fromRaw) return fromRaw;
  }
  if (place.category) {
    const fromCategory =
      RAW_CATEGORY_TO_DATA_SOURCE[place.category] ??
      RAW_CATEGORY_TO_DATA_SOURCE[place.category.toLowerCase()];
    if (fromCategory) return fromCategory;
  }
  // Fallback: check OSM tags for known amenity values
  const amenity = place.osmTags?.amenity;
  if (amenity === "charging_station") return "ev-charging";
  if (amenity === "fuel") return "fuel";
  if (amenity === "bicycle_rental") return "bike-sharing";
  if (amenity === "car_sharing") return "car-sharing";
  if (amenity === "parking") return "parking";
  return null;
}

/**
 * Hook that matches a Place to a DataSourceDetail when the place corresponds
 * to a known data source category (e.g. charging_station → ev-charging).
 *
 * Returns the matched DataSourceDetail or null.
 */
export function useDataSourceMatch(place: Place | null): DataSourceDetail | null {
  const sourceId = place && !place.dataSourceDetail ? resolveDataSourceId(place) : null;

  const lat = place?.coordinates[1] ?? 0;
  const lng = place?.coordinates[0] ?? 0;

  // Search for nearby data source items
  const { data: nearbyEnvelope } = useQuery({
    queryKey: ["ds-match-search", sourceId, lat, lng],
    queryFn: () => {
      const params: Record<string, string> = {
        south: String(lat - SEARCH_DELTA),
        west: String(lng - SEARCH_DELTA),
        north: String(lat + SEARCH_DELTA),
        east: String(lng + SEARCH_DELTA),
      };
      return apiClient.get<MobilityEnvelope<DataSourceResult[]>>(
        `${API_ENDPOINTS.dataSourceSearch}/${sourceId}/search`,
        params,
      );
    },
    enabled: sourceId !== null && place !== null,
    staleTime: 5 * 60 * 1000,
  });
  const nearbyResults = nearbyEnvelope?.data;

  // Find the closest match by coordinate proximity
  let bestMatch: DataSourceResult | null = null;
  if (nearbyResults && nearbyResults.length > 0 && place) {
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const r of nearbyResults) {
      const dist = haversineDistance(place.coordinates, r.coordinates);
      if (dist < bestDistance) {
        bestDistance = dist;
        bestMatch = r;
      }
    }
    // Only accept if within threshold
    if (bestDistance > MAX_MATCH_DISTANCE) {
      bestMatch = null;
    }
  }

  // Fetch detail for the closest match
  const { data: detailEnvelope } = useQuery({
    queryKey: ["ds-match-detail", sourceId, bestMatch?.id],
    queryFn: () =>
      apiClient.get<MobilityEnvelope<DataSourceDetail>>(
        `${API_ENDPOINTS.dataSourceDetail}/${sourceId}/detail/${bestMatch?.id}`,
      ),
    enabled: sourceId !== null && bestMatch !== null,
    staleTime: 5 * 60 * 1000,
  });
  const detail = detailEnvelope?.data;

  // Filter out minimal fallback details that have no useful data (e.g. when
  // the upstream provider is unavailable and only an Overpass stub is returned).
  if (detail && detail.sources[0] === "unknown" && detail.sections.length === 0) {
    return null;
  }

  return detail ?? null;
}
