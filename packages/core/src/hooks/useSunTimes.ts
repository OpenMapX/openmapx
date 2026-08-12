import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../api/client";

export interface SunTimesResponse {
  sunrise: string;
  sunset: string;
  solarNoon: string;
  dayLength: number;
  civilTwilightBegin: string;
  civilTwilightEnd: string;
  nauticalTwilightBegin: string;
  nauticalTwilightEnd: string;
  astronomicalTwilightBegin: string;
  astronomicalTwilightEnd: string;
  timezone: string;
  attribution: { name: string; url: string; license?: string; licenseUrl?: string };
}

export function useSunTimes(lat: number | null, lng: number | null, enabled = true) {
  return useQuery({
    queryKey: ["sun-times", lat, lng],
    queryFn: () =>
      apiClient.get<SunTimesResponse>("/api/integrations/knowledge-sun-time/times", {
        lat: String(lat),
        lng: String(lng),
      }),
    enabled: enabled && lat != null && lng != null,
    staleTime: 60 * 60 * 1000,
    refetchInterval: 6 * 60 * 60 * 1000,
  });
}
