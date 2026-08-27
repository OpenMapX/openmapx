import type { MobilityEnvelope } from "@openmapx/mobility-core/result";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../api/client";
import { API_ENDPOINTS } from "../api/endpoints";
import { apiQueryRequestOptions, DETAIL_QUERY_POLICY, MAP_QUERY_POLICY } from "../api/queryPolicy";
import type {
  DataSourceDetail,
  DataSourceFilterDef,
  DataSourceMapContext,
  DataSourceMapContextSelection,
  DataSourceMeta,
  DataSourceResult,
} from "../types/dataSource";
import type { BoundingBox } from "../types/geometry";
import {
  type MobilityEnvelopeQueryResult,
  wrapMobilityEnvelope,
} from "./transit/useMobilityEnvelope";

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
    queryFn: ({ signal }) =>
      apiClient.get<DataSourcesResponse>(
        API_ENDPOINTS.dataSources,
        undefined,
        apiQueryRequestOptions(signal, DETAIL_QUERY_POLICY),
      ),
    staleTime: 60 * 60 * 1000,
  });
}

export function useDataSourceSearch(
  sourceId: string | null,
  bbox: BoundingBox | null,
  filters: Record<string, unknown>,
): MobilityEnvelopeQueryResult<DataSourceResult[]> {
  const query = useQuery({
    queryKey: ["data-source-search", sourceId, bbox, filters],
    queryFn: ({ signal }) => {
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
      return apiClient.get<MobilityEnvelope<DataSourceResult[]>>(
        `${API_ENDPOINTS.dataSourceSearch}/${sourceId}/search`,
        params,
        apiQueryRequestOptions(signal, MAP_QUERY_POLICY),
      );
    },
    enabled: sourceId !== null && bbox !== null,
    staleTime: 30_000,
    gcTime: MAP_QUERY_POLICY.gcTime,
  });
  return wrapMobilityEnvelope(query);
}

export function useDataSourceDetail(
  sourceId: string | null,
  itemId: string | null,
): MobilityEnvelopeQueryResult<DataSourceDetail> {
  const query = useQuery({
    queryKey: ["data-source-detail", sourceId, itemId],
    queryFn: ({ signal }) =>
      apiClient.get<MobilityEnvelope<DataSourceDetail>>(
        `${API_ENDPOINTS.dataSourceDetail}/${sourceId}/detail/${itemId}`,
        undefined,
        apiQueryRequestOptions(signal, DETAIL_QUERY_POLICY),
      ),
    enabled: sourceId !== null && itemId !== null,
    staleTime: 5 * 60 * 1000,
    gcTime: DETAIL_QUERY_POLICY.gcTime,
  });
  return wrapMobilityEnvelope(query);
}

export function useDataSourceMapContext(
  sourceId: string | null,
  bbox: BoundingBox | null,
  filters: Record<string, unknown>,
  options: DataSourceMapContextSelection,
): MobilityEnvelopeQueryResult<DataSourceMapContext | null> {
  const query = useQuery({
    queryKey: ["data-source-map-context", sourceId, bbox, filters, options],
    queryFn: ({ signal }) => {
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
      return apiClient.get<MobilityEnvelope<DataSourceMapContext | null>>(
        `${API_ENDPOINTS.dataSourceDetail}/${sourceId}/map-context`,
        params,
        apiQueryRequestOptions(signal, MAP_QUERY_POLICY),
      );
    },
    enabled: sourceId !== null && bbox !== null,
    staleTime: 30_000,
    gcTime: MAP_QUERY_POLICY.gcTime,
  });
  return wrapMobilityEnvelope(query);
}
