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
  DataSourcePartialReason,
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
    // A source can join or leave the list at runtime (a fuel provider registering), and
    // nothing tells the browser, so the list is asked again after a few minutes.
    staleTime: 5 * 60 * 1000,
  });
}

/** A data-source search answer as the API sends it. */
interface DataSourceSearchEnvelope extends MobilityEnvelope<DataSourceResult[]> {
  /** Present when the area may hold results the answer lacks, saying why. */
  partial?: DataSourcePartialReason;
}

export interface DataSourceSearchQueryResult
  extends MobilityEnvelopeQueryResult<DataSourceResult[]> {
  /**
   * Why the area may hold results the answer lacks, or null when it does not:
   * `area` when a closer view loads more, `unavailable` when a source did not answer.
   */
  partial: DataSourcePartialReason | null;
}

const SEARCH_STALE_MS = 30_000;
/** How often, and how many times, a partial answer is asked again while the view stays put. */
const PARTIAL_REFETCH_MS = 5_000;
const PARTIAL_REFETCHES = 3;

/**
 * A partial answer is never fresh, and is asked again a few times: a source
 * fetching the missing part lands it within seconds. The first fetch is
 * update 1, so the count stops the refetches after the third.
 */
function partialRefetchInterval(query: {
  state: { data?: DataSourceSearchEnvelope; dataUpdateCount: number };
}): number | false {
  const { data, dataUpdateCount } = query.state;
  return data?.partial && dataUpdateCount <= PARTIAL_REFETCHES ? PARTIAL_REFETCH_MS : false;
}

export function useDataSourceSearch(
  sourceId: string | null,
  bbox: BoundingBox | null,
  filters: Record<string, unknown>,
): DataSourceSearchQueryResult {
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
      return apiClient.get<DataSourceSearchEnvelope>(
        `${API_ENDPOINTS.dataSourceSearch}/${sourceId}/search`,
        params,
        apiQueryRequestOptions(signal, MAP_QUERY_POLICY),
      );
    },
    enabled: sourceId !== null && bbox !== null,
    staleTime: (q) => (q.state.data?.partial ? 0 : SEARCH_STALE_MS),
    refetchInterval: partialRefetchInterval,
    gcTime: MAP_QUERY_POLICY.gcTime,
  });
  return { ...wrapMobilityEnvelope(query), partial: query.data?.partial ?? null };
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
