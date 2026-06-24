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

// Highways and tolls only apply to driving; the UI hides their toggles for
// other modes, so a stale flag (set while driving) must never reach a cycling /
// walking route. Ferries can be avoided on foot or bike too, so it is not gated.
function effectiveAvoid(mode: TravelMode, avoidHighways: boolean, avoidTolls: boolean) {
  return {
    avoidHighways: mode === "driving" && avoidHighways,
    avoidTolls: mode === "driving" && avoidTolls,
  };
}

/**
 * The single source of truth for the directions query key. Any component that
 * reads the directions cache (the panel's mode-chip time preview, the map
 * RouteLayer) MUST build its key with this so the keys can never drift apart —
 * a mismatch silently splits the cache and makes the map and panel disagree.
 */
export function directionsQueryKey({
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
}: UseDirectionsParams): (string | boolean | undefined)[] {
  const waypointsStr = waypoints.map(([lng, lat]) => `${lng},${lat}`).join(";");
  const eff = effectiveAvoid(mode, avoidHighways, avoidTolls);
  return [
    "directions",
    waypointsStr,
    mode,
    eff.avoidHighways,
    eff.avoidTolls,
    avoidFerries,
    avoidClosures,
    units,
    lang,
    departAt,
    arriveBy,
  ];
}

export function useDirections(params: UseDirectionsParams) {
  const {
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
  } = params;
  const eff = effectiveAvoid(mode, avoidHighways, avoidTolls);

  return useQuery({
    queryKey: directionsQueryKey(params),
    queryFn: () =>
      fetchDirections({
        waypoints,
        mode,
        avoidHighways: eff.avoidHighways,
        avoidTolls: eff.avoidTolls,
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
