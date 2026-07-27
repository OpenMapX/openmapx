import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../api/client";
import { API_ENDPOINTS } from "../api/endpoints";
import type { RestaurantLinks, RestaurantMenu } from "../types/restaurantMenu";

type MenuResponse = RestaurantLinks;

/**
 * Resolve a link to a restaurant's menu by crawling its website (schema.org
 * `hasMenu` → menu-link heuristics) via the backend `restaurants` integration.
 * Returns null when no menu link is found. Only call when the place has no OSM
 * `website:menu` tag (resolve those client-side with `resolveOsmMenuUrl`).
 */
export function useRestaurantMenu(website?: string | null, enabled = true) {
  return useQuery<RestaurantMenu | null>({
    queryKey: ["restaurant-menu", website ?? ""],
    queryFn: async () => {
      const res = await apiClient.getOptional<MenuResponse>(API_ENDPOINTS.restaurantMenu, {
        website: website as string,
      });
      if (!res?.menuUrl || !res.source || !res.format) return null;
      return {
        menuUrl: res.menuUrl,
        source: res.source,
        format: res.format,
      } satisfies RestaurantMenu;
    },
    enabled: enabled && Boolean(website),
    staleTime: 24 * 60 * 60 * 1000,
  });
}
