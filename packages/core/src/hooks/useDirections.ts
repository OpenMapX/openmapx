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
  /** When true, the server injects active road closures as Valhalla exclusions. */
  avoidClosures?: boolean;
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
  avoidClosures = false,
  units = "metric",
  lang,
  departAt,
  arriveBy,
}: UseDirectionsParams) {
  const waypointsStr = waypoints.map(([lng, lat]) => `${lng},${lat}`).join(";");

  // Highways and tolls only apply to driving; the UI hides their toggles for
  // other modes, so never send a stale flag (set while driving) to a cycling /
  // walking route the user can no longer clear. Ferries can be avoided on foot
  // or bike too, so it is not gated.
  const effectiveAvoidHighways = mode === "driving" && avoidHighways;
  const effectiveAvoidTolls = mode === "driving" && avoidTolls;

  return useQuery({
    queryKey: [
      "directions",
      waypointsStr,
      mode,
      effectiveAvoidHighways,
      effectiveAvoidTolls,
      avoidFerries,
      avoidClosures,
      units,
      lang,
      departAt,
      arriveBy,
    ],
    queryFn: () =>
      fetchDirections({
        waypoints,
        mode,
        avoidHighways: effectiveAvoidHighways,
        avoidTolls: effectiveAvoidTolls,
        avoidFerries,
        avoidClosures,
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
