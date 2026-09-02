import type { EvChargeStop, LngLat, Route, TravelMode } from "@openmapx/core";
import {
  useDirections,
  useDirectionsStore,
  useEvDirections,
  useNavigationStore,
  useSettingsStore,
  useVehicles,
} from "@openmapx/core";
import { useLocale } from "next-intl";
import { useMemo } from "react";
import {
  buildEvDirectionsRequest,
  GARAGE_VEHICLE_PREFIX,
  isGarageVehicleId,
} from "@/lib/buildEvDirectionsRequest";

// Stable fallbacks for the "nothing to draw yet" case. A fresh `[]` literal in
// the return statement would change identity every render, and RouteLayer's
// effects (map layer/source sync, EV pin sync) depend on `routes`/`evStops` —
// a new reference each render would re-run those effects (tearing down and
// re-adding map layers and event listeners) even when nothing changed.
const EMPTY_ROUTES: Route[] = [];
const EMPTY_EV_STOPS: EvChargeStop[] = [];

export interface DrawnDirectionsRoutes {
  routes: Route[];
  activeRouteIndex: number;
  provider?: string;
  mode: TravelMode;
  isEvMode: boolean;
  evStops: EvChargeStop[];
  /** True while turn-by-turn owns the on-map route; planning must not draw. */
  navigating: boolean;
}

/**
 * The geometry of whatever routes are currently drawn for the directions
 * planner: the plain-driving/cycling/walking route, or the EV plan (route +
 * inserted charge-stop legs) in EV mode. Shared by `RouteLayer` (the drawn
 * line + charge-stop pins) and any other consumer that needs the same
 * geometry — both hit the same TanStack query cache entry because the
 * request objects are built identically, so a second caller costs no extra
 * network request.
 *
 * `routes` is already emptied while `navigating` is true, since planning
 * must not draw once turn-by-turn owns the on-map route. A caller that needs
 * to distinguish "navigating" from "genuinely no route" should read
 * `navigating` directly rather than inferring it from an empty `routes`.
 */
export function useDrawnDirectionsRoutes(): DrawnDirectionsRoutes {
  const locale = useLocale();
  const {
    waypoints,
    mode,
    isEvMode,
    evSocStartPct,
    evSocArrivalMinPct,
    evForceNonExclusive,
    activeRouteIndex,
    avoidHighways,
    avoidTolls,
    avoidFerries,
  } = useDirectionsStore();
  const units = useSettingsStore((s) => s.units);
  const avoidIncidents = useSettingsStore((s) => s.avoidIncidents);
  const evVehicleId = useSettingsStore((s) => s.evVehicleId);
  const { data: garageVehicles } = useVehicles();
  const evSocTargetPct = useSettingsStore((s) => s.evSocTargetPct);
  const evPreferredNetworks = useSettingsStore((s) => s.evPreferredNetworks);
  const evAvoidedNetworks = useSettingsStore((s) => s.evAvoidedNetworks);
  const evExclusiveNetworks = useSettingsStore((s) => s.evExclusiveNetworks);
  const evPreferCheaper = useSettingsStore((s) => s.evPreferCheaper);
  const evHomePricePerKwh = useSettingsStore((s) => s.evHomePricePerKwh);
  const evHomeCurrency = useSettingsStore((s) => s.evHomeCurrency);
  // Once turn-by-turn navigation starts, NavigationRouteLayer owns the on-map
  // route (traveled/remaining split, live reroutes). Keep the directions preview
  // dark so a reroute doesn't leave the original planned line stranded on the
  // map — and so this layer's fitBounds never fights the navigation camera.
  const navigating = useNavigationStore((s) => s.status) !== "idle";

  const routeWaypoints = useMemo(
    () =>
      waypoints.reduce<LngLat[]>((acc, wp) => {
        if (wp.coords) acc.push(wp.coords);
        return acc;
      }, []),
    [waypoints],
  );
  const allFilled = routeWaypoints.length === waypoints.length && waypoints.length >= 2;

  const { data } = useDirections({
    // Transit uses the transit-plan endpoint and flights deep-link out — neither
    // routes through the ground engines, so skip the directions query for both.
    // EV mode routes through `useEvDirections` below instead. Skip it while
    // navigating too: the nav layer draws the live route.
    waypoints:
      navigating || isEvMode || mode === "transit" || mode === "flying"
        ? []
        : allFilled
          ? routeWaypoints
          : [],
    mode,
    avoidHighways,
    avoidTolls,
    avoidFerries,
    avoidClosures: avoidIncidents,
    units,
    lang: locale,
  });

  // Independent EV-plan query — built with the exact same request the plan
  // card (DirectionsPanelContent) sends, so this hits the same query-cache
  // entry instead of firing a second network request.
  const evRequest = useMemo(
    () =>
      buildEvDirectionsRequest({
        isEvMode,
        waypoints: routeWaypoints,
        allWaypointsFilled: allFilled,
        vehicleId: evVehicleId,
        garageVehicle:
          evVehicleId && isGarageVehicleId(evVehicleId)
            ? (garageVehicles?.find((v) => v.id === evVehicleId.slice(GARAGE_VEHICLE_PREFIX.length))
                ?.ev ?? null)
            : null,
        socStartPct: evSocStartPct,
        socArrivalMinPct: evSocArrivalMinPct,
        socTargetPct: evSocTargetPct,
        avoidHighways,
        avoidTolls,
        avoidFerries,
        avoidClosures: avoidIncidents,
        preferredNetworks: evPreferredNetworks,
        avoidedNetworks: evAvoidedNetworks,
        exclusiveNetworks: evExclusiveNetworks,
        forceNonExclusive: evForceNonExclusive,
        preferCheaper: evPreferCheaper,
        homePricePerKwh: evHomePricePerKwh,
        homeCurrency: evHomeCurrency,
        units,
        lang: locale,
      }),
    [
      isEvMode,
      routeWaypoints,
      allFilled,
      evVehicleId,
      garageVehicles,
      evSocStartPct,
      evSocArrivalMinPct,
      evSocTargetPct,
      avoidHighways,
      avoidTolls,
      avoidFerries,
      avoidIncidents,
      evPreferredNetworks,
      evAvoidedNetworks,
      evExclusiveNetworks,
      evForceNonExclusive,
      evPreferCheaper,
      evHomePricePerKwh,
      evHomeCurrency,
      units,
      locale,
    ],
  );
  const { data: evData } = useEvDirections(navigating ? null : evRequest);

  // The result actually drawn on the map: the EV plan (route + inserted
  // charge-stop legs) in EV mode, the plain route otherwise.
  const activeResult = isEvMode ? evData : data;

  return {
    routes: navigating ? EMPTY_ROUTES : (activeResult?.routes ?? EMPTY_ROUTES),
    activeRouteIndex,
    provider: activeResult?.provider,
    mode,
    isEvMode,
    evStops: isEvMode && evData ? evData.stops : EMPTY_EV_STOPS,
    navigating,
  };
}
