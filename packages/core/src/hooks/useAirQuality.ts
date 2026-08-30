import type {
  AirQualityCurrentResponse,
  AirQualityForecastResponse,
  AirQualityStandardId,
} from "@openmapx/air-quality";
import { useQuery } from "@tanstack/react-query";

import { apiClient } from "../api/client";

export type {
  AirQualityApiError,
  AirQualityCurrentResponse,
  AirQualityEvidence,
  AirQualityForecastResponse,
  AirQualityIndex,
  AirQualityProgramId,
  AirQualitySourceRef,
  AirQualityStandardId,
  AirQualityStationFeature,
  AirQualityStationsResponse,
  AirQualityWarningCode,
  Pollutant,
  PollutantWindowSummary,
} from "@openmapx/air-quality";

export interface AirQualityQueryOptions {
  enabled?: boolean;
  countryCode?: string;
  subdivisionCode?: string;
  comparisonStandard?: AirQualityStandardId;
}

export interface AirQualityForecastQueryOptions extends AirQualityQueryOptions {
  hours?: number;
}

function pointQuery(
  lat: number | null,
  lng: number | null,
  options: AirQualityQueryOptions,
): Record<string, string> {
  const query: Record<string, string> = { lat: String(lat), lng: String(lng) };
  if (options.countryCode) query.countryCode = options.countryCode;
  if (options.subdivisionCode) query.subdivisionCode = options.subdivisionCode;
  if (options.comparisonStandard) query.comparisonStandard = options.comparisonStandard;
  return query;
}

export function useAirQuality(
  lat: number | null,
  lng: number | null,
  options: AirQualityQueryOptions = {},
) {
  const { enabled = true, countryCode, subdivisionCode, comparisonStandard } = options;
  return useQuery({
    queryKey: [
      "air-quality",
      "current",
      lat,
      lng,
      countryCode,
      subdivisionCode,
      comparisonStandard,
    ],
    queryFn: ({ signal }) =>
      apiClient.get<AirQualityCurrentResponse>(
        "/api/integrations/air-quality/current",
        pointQuery(lat, lng, options),
        { signal },
      ),
    enabled: enabled && lat != null && lng != null,
    staleTime: 5 * 60 * 1_000,
  });
}

export function useAirQualityForecast(
  lat: number | null,
  lng: number | null,
  options: AirQualityForecastQueryOptions = {},
) {
  const { enabled = false, countryCode, subdivisionCode, comparisonStandard, hours = 48 } = options;
  return useQuery({
    queryKey: [
      "air-quality",
      "forecast",
      lat,
      lng,
      hours,
      countryCode,
      subdivisionCode,
      comparisonStandard,
    ],
    queryFn: ({ signal }) =>
      apiClient.get<AirQualityForecastResponse>(
        "/api/integrations/air-quality/forecast",
        { ...pointQuery(lat, lng, options), hours: String(hours) },
        { signal },
      ),
    enabled: enabled && lat != null && lng != null,
    staleTime: 5 * 60 * 1_000,
  });
}
