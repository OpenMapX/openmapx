import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../api/client";

/**
 * Beaufort/Douglas sea state descriptor — derived server-side from
 * significant wave height per the Douglas Sea Scale.
 */
export type DouglasSeaState =
  | "calm-glassy"
  | "calm-rippled"
  | "smooth"
  | "slight"
  | "moderate"
  | "rough"
  | "very-rough"
  | "high"
  | "very-high"
  | "phenomenal";

export interface MarineHourlyPoint {
  time: string;
  waveHeightM?: number;
  waveDirectionDeg?: number;
  wavePeriodS?: number;
  windWaveHeightM?: number;
  windWaveDirectionDeg?: number;
  windWavePeriodS?: number;
  swellHeightM?: number;
  swellDirectionDeg?: number;
  swellPeriodS?: number;
  currentVelocityMs?: number;
  currentDirectionDeg?: number;
  /** Modeled sea-level relative to MSL, in meters. Globally available. */
  seaLevelHeightM?: number;
}

export interface MarineCurrent {
  time: string;
  waveHeightM?: number;
  waveDirectionDeg?: number;
  wavePeriodS?: number;
  swellHeightM?: number;
  swellDirectionDeg?: number;
  swellPeriodS?: number;
  currentVelocityMs?: number;
  currentDirectionDeg?: number;
  seaState: DouglasSeaState;
}

export interface MarineWeatherResponse {
  location: { lat: number; lng: number };
  current: MarineCurrent;
  hourly: MarineHourlyPoint[];
  source: "open-meteo-marine";
}

/**
 * Fetch marine weather (waves, swell, ocean currents) for a coordinate.
 * Returns `null` (HTTP 204) for inland points where Open-Meteo's marine
 * grid has no data — the calling component should self-hide in that case.
 */
export function useMarineWeather(lat: number | null, lng: number | null, enabled = true) {
  return useQuery<MarineWeatherResponse | null>({
    queryKey: ["marine-weather", lat, lng],
    queryFn: () =>
      apiClient.getOptional<MarineWeatherResponse>(
        "/api/integrations/knowledge-marine-weather/marine",
        {
          lat: String(lat),
          lng: String(lng),
        },
      ),
    enabled: enabled && lat != null && lng != null,
    staleTime: 30 * 60 * 1000,
    refetchInterval: 60 * 60 * 1000,
    retry: false,
  });
}
