import { useQuery } from "@tanstack/react-query";
import { apiClient, isApiClientError } from "../api/client";
import { API_ENDPOINTS } from "../api/endpoints";
import { apiQueryRequestOptions, MAP_QUERY_POLICY } from "../api/queryPolicy";
import type { CategoryId, CategorySearchResponse } from "../types/category";
import type { BoundingBox } from "../types/geometry";

/**
 * Key, request and retry rule of one category search over one box. Shared by
 * {@link useCategorySearch} and callers that search several boxes at once, so
 * the same area is cached once whichever surface asked for it.
 */
export function categorySearchQueryOptions(category: string, bbox: BoundingBox, lang?: string) {
  return {
    queryKey: ["category-search", category, bbox, lang] as const,
    queryFn: ({ signal }: { signal: AbortSignal }) =>
      apiClient.get<CategorySearchResponse>(
        API_ENDPOINTS.categorySearch,
        {
          category,
          south: String(bbox.south),
          west: String(bbox.west),
          north: String(bbox.north),
          east: String(bbox.east),
          ...(lang && { lang }),
        },
        apiQueryRequestOptions(signal, MAP_QUERY_POLICY),
      ),
    gcTime: MAP_QUERY_POLICY.gcTime,
    retry: (failureCount: number, error: unknown) => failureCount < 2 && !isAreaTooLarge(error),
  };
}

/** Never requested: the query stays disabled until a real box is known. */
const DISABLED_BBOX: BoundingBox = { south: 0, west: 0, north: 0, east: 0 };

export function useCategorySearch(
  category: CategoryId | null,
  bbox: BoundingBox | null,
  lang?: string,
) {
  return useQuery({
    ...categorySearchQueryOptions(category as string, bbox ?? DISABLED_BBOX, lang),
    queryKey: ["category-search", category, bbox, lang],
    enabled: category !== null && bbox !== null,
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}

export function isAreaTooLarge(error: unknown): boolean {
  if (isApiClientError(error)) {
    const payload = error.payload;
    return (
      typeof payload === "object" &&
      payload !== null &&
      (payload as { error?: unknown }).error === "area_too_large"
    );
  }
  return error instanceof Error && error.message.includes("area_too_large");
}
