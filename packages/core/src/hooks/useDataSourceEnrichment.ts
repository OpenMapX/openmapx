import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../api/client";
import { API_ENDPOINTS } from "../api/endpoints";
import { CATEGORY_DEFINITIONS } from "../types/category";
import type { DataSourceDetail, DataSourceResult } from "../types/dataSource";
import type { Place } from "../types/place";
import { haversineDistance } from "../utils/coordinates";

/**
 * Mapping from OSM raw category strings to data source IDs.
 * When a place has one of these raw categories and no `dataSourceDetail`,
 * we try to enrich it by searching the data source API for nearby matches.
 */
const RAW_CATEGORY_TO_DATA_SOURCE: Record<string, string> = {
  charging_station: "ev-charging",
  "amenity/charging_station": "ev-charging",
  // MapTiler/OpenMapTiles POI class/subclass combinations
  "car/charging_station": "ev-charging",
  "fuel/charging_station": "ev-charging",
};

// Also build mappings from CategoryDefinition entries that have dataSourceId
for (const def of CATEGORY_DEFINITIONS) {
  if (def.dataSourceId) {
    RAW_CATEGORY_TO_DATA_SOURCE[def.id] = def.dataSourceId;
  }
}

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
    const fromCategory = RAW_CATEGORY_TO_DATA_SOURCE[place.category];
    if (fromCategory) return fromCategory;
  }
  // Check OSM tags for amenity=charging_station
  if (place.osmTags?.amenity === "charging_station") {
    return "ev-charging";
  }
  return null;
}

/**
 * Hook that enriches a Place with DataSourceDetail when the place matches
 * a known data source mapping (e.g. charging_station → ev-charging).
 *
 * Returns the matched DataSourceDetail or null.
 */
export function useDataSourceEnrichment(place: Place | null): DataSourceDetail | null {
  const sourceId = place && !place.dataSourceDetail ? resolveDataSourceId(place) : null;

  const lat = place?.coordinates[1] ?? 0;
  const lng = place?.coordinates[0] ?? 0;

  // Search for nearby data source items
  const { data: nearbyResults } = useQuery({
    queryKey: ["ds-enrichment-search", sourceId, lat, lng],
    queryFn: () => {
      const params: Record<string, string> = {
        south: String(lat - SEARCH_DELTA),
        west: String(lng - SEARCH_DELTA),
        north: String(lat + SEARCH_DELTA),
        east: String(lng + SEARCH_DELTA),
      };
      return apiClient.get<DataSourceResult[]>(
        `${API_ENDPOINTS.dataSourceSearch}/${sourceId}/search`,
        params,
      );
    },
    enabled: sourceId !== null && place !== null,
    staleTime: 5 * 60 * 1000,
  });

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
  const { data: detail } = useQuery({
    queryKey: ["ds-enrichment-detail", sourceId, bestMatch?.id],
    queryFn: () =>
      apiClient.get<DataSourceDetail>(
        `${API_ENDPOINTS.dataSourceDetail}/${sourceId}/detail/${bestMatch?.id}`,
      ),
    enabled: sourceId !== null && bestMatch !== null,
    staleTime: 5 * 60 * 1000,
  });

  return detail ?? null;
}
