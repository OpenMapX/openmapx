import type {
  DataSourceDetail,
  DataSourceFilterDef,
  DataSourceMeta,
  DataSourceResult,
} from "@integrations/data-source/types";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../api/client";
import { API_ENDPOINTS } from "../api/endpoints";
import type { BoundingBox } from "../types/geometry";

interface DataSourcesResponse {
  sources: (DataSourceMeta & { filters: DataSourceFilterDef[] })[];
}

export function useDataSources() {
  return useQuery({
    queryKey: ["data-sources"],
    queryFn: () => apiClient.get<DataSourcesResponse>(API_ENDPOINTS.dataSources),
    staleTime: 60 * 60 * 1000,
  });
}

export function useDataSourceSearch(
  sourceId: string | null,
  bbox: BoundingBox | null,
  filters: Record<string, unknown>,
) {
  return useQuery({
    queryKey: ["data-source-search", sourceId, bbox, filters],
    queryFn: () => {
      if (!bbox) throw new Error("bbox is required");
      const params: Record<string, string> = {
        south: String(bbox.south),
        west: String(bbox.west),
        north: String(bbox.north),
        east: String(bbox.east),
      };
      const activeFilters = Object.fromEntries(
        Object.entries(filters).filter(([, v]) => {
          if (Array.isArray(v)) return v.length > 0;
          return v !== undefined && v !== null;
        }),
      );
      if (Object.keys(activeFilters).length > 0) {
        params.filters = JSON.stringify(activeFilters);
      }
      return apiClient.get<DataSourceResult[]>(
        `${API_ENDPOINTS.dataSourceSearch}/${sourceId}/search`,
        params,
      );
    },
    enabled: sourceId !== null && bbox !== null,
    staleTime: 30_000,
  });
}

export function useDataSourceDetail(sourceId: string | null, itemId: string | null) {
  return useQuery({
    queryKey: ["data-source-detail", sourceId, itemId],
    queryFn: () =>
      apiClient.get<DataSourceDetail>(
        `${API_ENDPOINTS.dataSourceDetail}/${sourceId}/detail/${itemId}`,
      ),
    enabled: sourceId !== null && itemId !== null,
    staleTime: 5 * 60 * 1000,
  });
}
