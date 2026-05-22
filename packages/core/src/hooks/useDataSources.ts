import type {
  DataSourceDetail,
  DataSourceFilterDef,
  DataSourceMapContext,
  DataSourceMapContextSelection,
  DataSourceMeta,
  DataSourceResult,
} from "@openmapx/integration-framework";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../api/client";
import { API_ENDPOINTS } from "../api/endpoints";
import type { BoundingBox } from "../types/geometry";

interface DataSourcesResponse {
  sources: (DataSourceMeta & {
    id: string;
    name: string;
    categoryChipLabel: string;
    filters: DataSourceFilterDef[];
  })[];
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

export function useDataSourceMapContext(
  sourceId: string | null,
  bbox: BoundingBox | null,
  filters: Record<string, unknown>,
  options: DataSourceMapContextSelection,
) {
  return useQuery({
    queryKey: ["data-source-map-context", sourceId, bbox, filters, options],
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
      const activeOptions = Object.fromEntries(
        Object.entries(options).filter(([, v]) => {
          if (Array.isArray(v)) return v.length > 0;
          return v !== undefined && v !== null;
        }),
      );
      if (Object.keys(activeOptions).length > 0) {
        params.options = JSON.stringify(activeOptions);
      }
      return apiClient.get<DataSourceMapContext | null>(
        `${API_ENDPOINTS.dataSourceDetail}/${sourceId}/map-context`,
        params,
      );
    },
    enabled: sourceId !== null && bbox !== null,
    staleTime: 30_000,
  });
}
