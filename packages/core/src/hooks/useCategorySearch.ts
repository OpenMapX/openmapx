import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../api/client";
import { API_ENDPOINTS } from "../api/endpoints";
import type { CategoryId, CategoryPlace } from "../types/category";
import type { BoundingBox } from "../types/geometry";

export function useCategorySearch(category: CategoryId | null, bbox: BoundingBox | null) {
  return useQuery({
    queryKey: ["category-search", category, bbox],
    queryFn: () =>
      apiClient.get<CategoryPlace[]>(API_ENDPOINTS.categorySearch, {
        category: category as string,
        south: String(bbox?.south),
        west: String(bbox?.west),
        north: String(bbox?.north),
        east: String(bbox?.east),
      }),
    enabled: category !== null && bbox !== null,
    staleTime: 30_000,
  });
}
