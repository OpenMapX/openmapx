import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../api/client";
import { API_ENDPOINTS } from "../api/endpoints";
import type { CategoryId, CategorySearchResponse } from "../types/category";
import type { BoundingBox } from "../types/geometry";

export function useCategorySearch(
  category: CategoryId | null,
  bbox: BoundingBox | null,
  lang?: string,
) {
  return useQuery({
    queryKey: ["category-search", category, bbox, lang],
    queryFn: () =>
      apiClient.get<CategorySearchResponse>(API_ENDPOINTS.categorySearch, {
        category: category as string,
        south: String(bbox?.south),
        west: String(bbox?.west),
        north: String(bbox?.north),
        east: String(bbox?.east),
        ...(lang && { lang }),
      }),
    enabled: category !== null && bbox !== null,
    staleTime: 30_000,
    retry: (_count, error) => !isAreaTooLarge(error),
  });
}

export function isAreaTooLarge(error: unknown): boolean {
  return error instanceof Error && error.message.includes("area_too_large");
}
