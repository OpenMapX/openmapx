import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../api/client";
import { API_ENDPOINTS } from "../api/endpoints";
import type { RestaurantLinks } from "../types/restaurantMenu";

export function useRestaurantLinks(website?: string | null, enabled = true) {
  return useQuery<RestaurantLinks | null>({
    queryKey: ["restaurant-links", website ?? ""],
    queryFn: () =>
      apiClient.getOptional<RestaurantLinks>(API_ENDPOINTS.restaurantMenu, {
        website: website as string,
      }),
    enabled: enabled && Boolean(website),
    staleTime: 24 * 60 * 60 * 1000,
  });
}
