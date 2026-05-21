import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../api/client";

export interface TideEvent {
  /** Local time `YYYY-MM-DD HH:mm` in the station's lst_ldt time zone. */
  time: string;
  type: "H" | "L";
  /** Water level above MLLW, in feet. */
  valueFt: number;
}

export interface TideCurvePoint {
  time: string;
  valueFt: number;
}

export interface WaterLevelObservation {
  time: string;
  valueFt: number;
  quality?: "p" | "v" | string;
}

export interface MetObservation {
  airTempF?: number;
  waterTempF?: number;
  windKnots?: number;
  windDirDeg?: number;
  windGustKnots?: number;
  pressureMb?: number;
  humidityPct?: number;
  time?: string;
}

/** Identifies which integration produced a TidesResponse, so the UI can show
 *  the correct attribution (each tide provider has different license terms). */
export interface TideProvider {
  /** Manifest id of the responding integration, e.g. "knowledge-tides-canada". */
  integrationId: string;
  /** `dataSources[].sourceId` of the upstream API, e.g. "dfo-iwls". */
  sourceId: string;
}

export interface TidesResponse {
  station: {
    id: string;
    name: string;
    lat: number;
    lng: number;
    distanceKm: number;
    timezoneCorrHours?: number;
  };
  events: TideEvent[];
  /** 30-min tide curve for charting. Empty when the upstream returned no data. */
  curve: TideCurvePoint[];
  datum: "MLLW";
  units: "english";
  timeZone: "lst_ldt";
  /** Latest 6-min observed water level, when the station publishes one. */
  currentLevel?: WaterLevelObservation;
  /** Latest met readings (wind, pressure, air/water temp), when published. */
  met?: MetObservation;
  /** Which integration responded — set client-side so the panel attribution
   *  reflects the actual provider rather than always crediting NOAA. */
  provider: TideProvider;
}

/**
 * Knowledge integrations that publish a `/tides?lat=&lng=` endpoint returning
 * a `TidesResponse` (or HTTP 204 for "no station in range"). Probed in this
 * order on the client — the first to return data wins, then the lookup short-
 * circuits. National prediction networks first, then EMODnet/IOC observations
 * for global coastal coverage.
 */
const TIDE_PROVIDERS: ReadonlyArray<{ endpoint: string; provider: TideProvider }> = [
  {
    endpoint: "/api/integrations/knowledge-noaa-tides/tides",
    provider: { integrationId: "knowledge-noaa-tides", sourceId: "noaa-co-ops" },
  },
  {
    endpoint: "/api/integrations/knowledge-tides-canada/tides",
    provider: { integrationId: "knowledge-tides-canada", sourceId: "dfo-iwls" },
  },
  {
    endpoint: "/api/integrations/knowledge-tides-norway/tides",
    provider: { integrationId: "knowledge-tides-norway", sourceId: "kartverket-sehavniva" },
  },
  {
    endpoint: "/api/integrations/knowledge-tides-pegelonline/tides",
    provider: { integrationId: "knowledge-tides-pegelonline", sourceId: "wsv-pegelonline" },
  },
  {
    endpoint: "/api/integrations/knowledge-tides-ioc/tides",
    provider: { integrationId: "knowledge-tides-ioc", sourceId: "ioc-sealevel" },
  },
] as const;

/**
 * Fetch today + tomorrow high/low tide events for the nearest available
 * station across all installed prediction networks (NOAA, Canada, Norway,
 * Pegelonline, IOC). Returns `null` (HTTP 204) when no station from any
 * provider is within range — the calling component should self-hide in that case.
 *
 * Networks are probed in priority order on the client; the first non-204
 * response wins. Each provider returns 204 fast when no station is in range,
 * so the inland-user cost is bounded by the slowest 204 (typically <50 ms).
 */
export function useTides(lat: number | null, lng: number | null, enabled = true) {
  return useQuery<TidesResponse | null>({
    queryKey: ["tides", lat, lng],
    queryFn: async () => {
      for (const { endpoint, provider } of TIDE_PROVIDERS) {
        const result = await apiClient
          .getOptional<Omit<TidesResponse, "provider">>(endpoint, {
            lat: String(lat),
            lng: String(lng),
          })
          .catch(() => null);
        if (result) return { ...result, provider };
      }
      return null;
    },
    enabled: enabled && lat != null && lng != null,
    staleTime: 60 * 60 * 1000,
    refetchInterval: 6 * 60 * 60 * 1000,
    retry: false,
  });
}
