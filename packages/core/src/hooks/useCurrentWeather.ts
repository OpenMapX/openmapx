import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../api/client";
import type { WeatherResponse } from "../domains/weather";

export function useCurrentWeather(lat: number | null, lng: number | null, enabled = true) {
  return useQuery({
    queryKey: ["weather", "current", lat, lng],
    queryFn: () =>
      apiClient.get<WeatherResponse>("/api/weather/current", {
        lat: String(lat),
        lng: String(lng),
      }),
    enabled: enabled && lat != null && lng != null,
    staleTime: 5 * 60 * 1000,
    refetchInterval: 10 * 60 * 1000,
  });
}
