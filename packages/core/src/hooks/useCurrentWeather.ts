import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../api/client";

/** Inline response type matching the weather orchestrator output. */
interface WeatherResponse {
  location: [number, number];
  current: {
    temperature: number;
    feelsLike: number;
    humidity: number;
    pressure: number;
    windSpeed: number;
    windDirection: number;
    windGusts?: number;
    precipitation: number;
    cloudCover: number;
    weatherCode: number;
    isDay: boolean;
    time: string;
  };
  hourly?: unknown[];
  daily?: unknown[];
  source: string;
  attribution?: { name: string; url: string; license: string; licenseUrl?: string };
}

export function useCurrentWeather(lat: number | null, lng: number | null, enabled = true) {
  return useQuery({
    queryKey: ["weather", "current", lat, lng],
    queryFn: () =>
      apiClient.get<WeatherResponse>("/api/integrations/weather/current", {
        lat: String(lat),
        lng: String(lng),
      }),
    enabled: enabled && lat != null && lng != null,
    staleTime: 5 * 60 * 1000,
    refetchInterval: 10 * 60 * 1000,
  });
}
