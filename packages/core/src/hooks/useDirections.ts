import type { TravelMode } from "@integrations/routing/types";
import { useQuery } from "@tanstack/react-query";
import { fetchDirections } from "../api/directions";
import type { LngLat } from "../types/geometry";

interface UseDirectionsParams {
  waypoints: LngLat[];
  mode?: TravelMode;
  avoidHighways?: boolean;
  avoidTolls?: boolean;
  avoidFerries?: boolean;
  units?: "metric" | "imperial";
  lang?: string;
  /** Wall-clock departure time `YYYY-MM-DDTHH:mm`. Mutually exclusive with `arriveBy`. */
  departAt?: string;
  /** Wall-clock arrival time `YYYY-MM-DDTHH:mm`. Mutually exclusive with `departAt`. */
  arriveBy?: string;
}

export function useDirections({
  waypoints,
  mode = "driving",
  avoidHighways = false,
  avoidTolls = false,
  avoidFerries = false,
  units = "metric",
  lang,
  departAt,
  arriveBy,
}: UseDirectionsParams) {
  const waypointsStr = waypoints.map(([lng, lat]) => `${lng},${lat}`).join(";");

  return useQuery({
    queryKey: [
      "directions",
      waypointsStr,
      mode,
      avoidHighways,
      avoidTolls,
      avoidFerries,
      units,
      lang,
      departAt,
      arriveBy,
    ],
    queryFn: () =>
      fetchDirections({
        waypoints,
        mode,
        avoidHighways,
        avoidTolls,
        avoidFerries,
        units,
        lang,
        departAt,
        arriveBy,
      }),
    enabled: waypoints.length >= 2,
    staleTime: 120_000,
    gcTime: 600_000,
  });
}
