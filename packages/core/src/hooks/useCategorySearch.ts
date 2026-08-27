import { useQuery } from "@tanstack/react-query";
import { apiClient, isApiClientError } from "../api/client";
import { API_ENDPOINTS } from "../api/endpoints";
import { apiQueryRequestOptions, MAP_QUERY_POLICY } from "../api/queryPolicy";
import type { CategoryId, CategorySearchResponse } from "../types/category";
import type { BoundingBox } from "../types/geometry";

export function useCategorySearch(
  category: CategoryId | null,
  bbox: BoundingBox | null,
  lang?: string,
) {
  return useQuery({
    queryKey: ["category-search", category, bbox, lang],
    queryFn: ({ signal }) =>
      apiClient.get<CategorySearchResponse>(
        API_ENDPOINTS.categorySearch,
        {
          category: category as string,
          south: String(bbox?.south),
          west: String(bbox?.west),
          north: String(bbox?.north),
          east: String(bbox?.east),
          ...(lang && { lang }),
        },
        apiQueryRequestOptions(signal, MAP_QUERY_POLICY),
      ),
    enabled: category !== null && bbox !== null,
    staleTime: 30_000,
    gcTime: MAP_QUERY_POLICY.gcTime,
    retry: (_count, error) => !isAreaTooLarge(error),
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
