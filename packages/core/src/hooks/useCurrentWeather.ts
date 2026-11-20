import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../api/client";
import type { WeatherResponse } from "../types/weather";

export function useCurrentWeather(lat: number | null, lng: number | null, enabled = true) {
  return useQuery({
    queryKey: ["weather", "current", lat, lng],
    queryFn: ({ signal }) =>
      apiClient.get<WeatherResponse>(
        "/api/integrations/weather/current",
        {
          lat: String(lat),
          lng: String(lng),
        },
        { signal },
      ),
    enabled: enabled && lat != null && lng != null,
    staleTime: 5 * 60 * 1000,
    refetchInterval: 10 * 60 * 1000,
  });
}
