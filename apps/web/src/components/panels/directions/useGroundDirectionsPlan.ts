"use client";

import {
  type DirectionsResult,
  directionsQueryKey,
  type EvDirectionsResult,
  formatDuration,
  type ScheduledDirectionsResult,
  type TravelMode,
  useDebounce,
  useDirections,
  useDirectionsStore,
  useEvDirections,
  useScheduledDirections,
  useSettingsStore,
  useVehicles,
} from "@openmapx/core";
import { useIntegrationRegistry } from "@openmapx/integration-framework/react";
import type { Attribution } from "@openmapx/mobility-core/attribution";
import {
  contributorsForField,
  contributorsForNestedRecordFields,
  snapshotContributors,
} from "@openmapx/mobility-core/contributors";
import { type QueryKey, useQueryClient } from "@tanstack/react-query";
import { useLocale } from "next-intl";
import { useCallback, useMemo, useSyncExternalStore } from "react";
import { useShallow } from "zustand/react/shallow";
import { MODES } from "@/components/panels/directions/ModeSelector";
import {
  buildEvDirectionsRequest,
  GARAGE_VEHICLE_PREFIX,
  isGarageVehicleId,
} from "@/lib/buildEvDirectionsRequest";
import { buildScheduleRequest } from "@/lib/directions/scheduleRequest";
import { routeAttributions } from "@/lib/routeAttributions";
import {
  buildArrivalContext,
  buildGroundRequest,
  drivingWallClocks,
  placedCoordinates,
  tripComplete,
} from "./directionsRequests";
import { planState } from "./RouteResultStates";
import { useRouteImpacts } from "./useRouteImpacts";

/** A mode button's duration and the receipts that own it. */
export interface ModeDuration {
  time: string;
  contributors: Attribution[];
}

const DURATION_MODES = MODES.filter((button) => button.mode !== "transit" && !button.disabled).map(
  (button) => button.mode,
);

/**
 * The cached data under each key, without fetching or observing it. The
 * component re-renders when any of them is written or dropped.
 */
function useCachedQueryData<T>(keys: readonly QueryKey[]): (T | undefined)[] {
  const queryClient = useQueryClient();
  const cache = queryClient.getQueryCache();
  // Only a write or a removal changes cached data. Other events, such as a
  // query created while another component renders, must not update this one
  // during that render.
  const subscribe = useCallback(
    (onChange: () => void) =>
      cache.subscribe((event) => {
        if (
          event.type === "removed" ||
          (event.type === "updated" && event.action.type === "success")
        )
          onChange();
      }),
    [cache],
  );
  const written = () =>
    keys.map((key) => queryClient.getQueryState(key)?.dataUpdatedAt ?? 0).join(",");
  useSyncExternalStore(subscribe, written, written);
  return keys.map((key) => queryClient.getQueryData<T>(key));
}

const hasNoRoutes = (result: { routes: readonly unknown[] }) => result.routes.length === 0;

/**
 * The ground, scheduled and EV plans of the trip in the directions store, with
 * what the panel shows around them: the displayed result's attribution, the
 * fastest route, route impacts and the durations other modes already know.
 * Only one of the three plans runs: the scheduled plan takes over once a stop
 * carries a time window, and EV mode plans charge stops instead.
 */
export type GroundDirectionsPlan = ReturnType<typeof useGroundDirectionsPlan>;

export function useGroundDirectionsPlan() {
  const locale = useLocale();
  const registry = useIntegrationRegistry();
  const directions = useDirectionsStore(
    useShallow((s) => ({
      waypoints: s.waypoints,
      mode: s.mode,
      isEvMode: s.isEvMode,
      evSocStartPct: s.evSocStartPct,
      evSocArrivalMinPct: s.evSocArrivalMinPct,
      evForceNonExclusive: s.evForceNonExclusive,
      avoidHighways: s.avoidHighways,
      avoidTolls: s.avoidTolls,
      avoidFerries: s.avoidFerries,
      bikeProfile: s.bikeProfile,
      bikeHillPreference: s.bikeHillPreference,
      bikePreferQuietRoads: s.bikePreferQuietRoads,
      bikePreferSmoothSurfaces: s.bikePreferSmoothSurfaces,
      bikeSpeedKmh: s.bikeSpeedKmh,
      timeMode: s.timeMode,
      tripTime: s.tripTime,
      routingProvider: s.routingProvider,
    })),
  );
  const settings = useSettingsStore(
    useShallow((s) => ({
      units: s.units,
      avoidIncidents: s.avoidIncidents,
      evVehicleId: s.evVehicleId,
      evSocTargetPct: s.evSocTargetPct,
      evPreferredNetworks: s.evPreferredNetworks,
      evAvoidedNetworks: s.evAvoidedNetworks,
      evExclusiveNetworks: s.evExclusiveNetworks,
      evPreferCheaper: s.evPreferCheaper,
      evHomePricePerKwh: s.evHomePricePerKwh,
      evHomeCurrency: s.evHomeCurrency,
    })),
  );
  const { data: garageVehicles } = useVehicles();
  const { waypoints, mode, isEvMode, timeMode } = directions;
  const { units, avoidIncidents } = settings;

  // Ride mode still needs the real road route: it draws on the map and gives
  // the panel its trip summary, so it plans like driving.
  const routeMode: TravelMode = mode === "ride" ? "driving" : mode;
  const plansGround = mode !== "transit" && mode !== "flying";
  const routeWaypoints = useMemo(() => placedCoordinates(waypoints), [waypoints]);
  const allWaypointsFilled = tripComplete(waypoints);
  const origin = waypoints[0]?.coords ?? null;
  const destination = waypoints.at(-1)?.coords ?? null;

  // Debounced so dragging the time picker does not plan per change.
  const tripTime = useDebounce(directions.tripTime, 500);
  const { departAt, arriveBy } = drivingWallClocks(mode, timeMode, tripTime);
  const arrivalContext = buildArrivalContext({
    mode,
    timeMode,
    departAt,
    arriveBy,
    origin,
    destination,
  });

  const scheduleRequest = useMemo(
    () =>
      !plansGround || isEvMode
        ? null
        : buildScheduleRequest({
            waypoints,
            mode: routeMode,
            timeMode,
            tripTime,
            avoidHighways: directions.avoidHighways,
            avoidTolls: directions.avoidTolls,
            avoidFerries: directions.avoidFerries,
            bikeProfile: directions.bikeProfile,
            bikeHillPreference: directions.bikeHillPreference,
            bikePreferQuietRoads: directions.bikePreferQuietRoads,
            bikePreferSmoothSurfaces: directions.bikePreferSmoothSurfaces,
            bikeSpeedKmh: directions.bikeSpeedKmh,
            avoidClosures: avoidIncidents,
            units,
            lang: locale,
          }),
    [
      plansGround,
      isEvMode,
      waypoints,
      routeMode,
      timeMode,
      tripTime,
      directions.avoidHighways,
      directions.avoidTolls,
      directions.avoidFerries,
      directions.bikeProfile,
      directions.bikeHillPreference,
      directions.bikePreferQuietRoads,
      directions.bikePreferSmoothSurfaces,
      directions.bikeSpeedKmh,
      avoidIncidents,
      units,
      locale,
    ],
  );
  const scheduledQuery = useScheduledDirections(scheduleRequest);

  const groundRequest = useMemo(
    () =>
      buildGroundRequest({
        mode: routeMode,
        avoidHighways: directions.avoidHighways,
        avoidTolls: directions.avoidTolls,
        avoidFerries: directions.avoidFerries,
        bikeProfile: directions.bikeProfile,
        bikeHillPreference: directions.bikeHillPreference,
        bikePreferQuietRoads: directions.bikePreferQuietRoads,
        bikePreferSmoothSurfaces: directions.bikePreferSmoothSurfaces,
        bikeSpeedKmh: directions.bikeSpeedKmh,
        avoidClosures: avoidIncidents,
        units,
        lang: locale,
        departAt,
        arriveBy,
        provider: directions.routingProvider ?? undefined,
      }),
    [
      directions.routingProvider,
      routeMode,
      directions.avoidHighways,
      directions.avoidTolls,
      directions.avoidFerries,
      directions.bikeProfile,
      directions.bikeHillPreference,
      directions.bikePreferQuietRoads,
      directions.bikePreferSmoothSurfaces,
      directions.bikeSpeedKmh,
      avoidIncidents,
      units,
      locale,
      departAt,
      arriveBy,
    ],
  );
  const directionsQuery = useDirections({
    ...groundRequest,
    waypoints:
      plansGround && !isEvMode && !scheduleRequest && allWaypointsFilled ? routeWaypoints : [],
  });

  // Built exactly as RouteLayer builds its own request, so both read one cache entry.
  const garageVehicle =
    settings.evVehicleId && isGarageVehicleId(settings.evVehicleId)
      ? (garageVehicles?.find(
          (v) => v.id === settings.evVehicleId?.slice(GARAGE_VEHICLE_PREFIX.length),
        )?.ev ?? null)
      : null;
  const evRequest = useMemo(
    () =>
      buildEvDirectionsRequest({
        isEvMode,
        waypoints: routeWaypoints,
        allWaypointsFilled,
        vehicleId: settings.evVehicleId,
        garageVehicle,
        socStartPct: directions.evSocStartPct,
        socArrivalMinPct: directions.evSocArrivalMinPct,
        socTargetPct: settings.evSocTargetPct,
        departAt,
        avoidHighways: directions.avoidHighways,
        avoidTolls: directions.avoidTolls,
        avoidFerries: directions.avoidFerries,
        avoidClosures: avoidIncidents,
        preferredNetworks: settings.evPreferredNetworks,
        avoidedNetworks: settings.evAvoidedNetworks,
        exclusiveNetworks: settings.evExclusiveNetworks,
        forceNonExclusive: directions.evForceNonExclusive,
        preferCheaper: settings.evPreferCheaper,
        homePricePerKwh: settings.evHomePricePerKwh,
        homeCurrency: settings.evHomeCurrency,
        units,
        lang: locale,
      }),
    [
      isEvMode,
      routeWaypoints,
      allWaypointsFilled,
      settings.evVehicleId,
      garageVehicle,
      directions.evSocStartPct,
      directions.evSocArrivalMinPct,
      settings.evSocTargetPct,
      departAt,
      directions.avoidHighways,
      directions.avoidTolls,
      directions.avoidFerries,
      avoidIncidents,
      settings.evPreferredNetworks,
      settings.evAvoidedNetworks,
      settings.evExclusiveNetworks,
      directions.evForceNonExclusive,
      settings.evPreferCheaper,
      settings.evHomePricePerKwh,
      settings.evHomeCurrency,
      units,
      locale,
    ],
  );
  const evQuery = useEvDirections(evRequest);

  const displayed: DirectionsResult | ScheduledDirectionsResult | undefined = scheduleRequest
    ? scheduledQuery.data
    : directionsQuery.data;
  const multiStop = waypoints.length > 2;
  const routingAttributions = useMemo<Attribution[]>(() => {
    const routes = displayed?.routes ?? [];
    // A plain multi-stop trip shows one route with its legs.
    const legsShown = !scheduleRequest && multiStop;
    const shown = legsShown ? routes.slice(0, 1) : routes;
    return snapshotContributors(
      ...shown.map((route) =>
        snapshotContributors(
          routeAttributions(registry, displayed?.provider, route, [
            "distance",
            "duration",
            "mode",
            ...(route.summary ? ["summary"] : []),
            ...(route.usesLocalAccessRoad ? ["usesLocalAccessRoad"] : []),
            ...((route.mode === "walking" || route.mode === "cycling") && route.elevation?.length
              ? ["geometry", "elevation"]
              : []),
          ]),
          ...(legsShown && route.legs.length > 1
            ? route.legs.map((leg, index) =>
                contributorsForNestedRecordFields(
                  route,
                  [{ field: `legs.${index}`, record: leg }],
                  ["duration", "distance"],
                ),
              )
            : []),
        ),
      ),
    );
  }, [registry, displayed, scheduleRequest, multiStop]);

  const impactRoutes = displayed?.routes ?? [];
  const fastestRouteIndex = useMemo(
    () =>
      impactRoutes.length === 0
        ? -1
        : impactRoutes.reduce(
            (fastest, route, index) =>
              route.duration < (impactRoutes[fastest]?.duration ?? Number.POSITIVE_INFINITY)
                ? index
                : fastest,
            0,
          ),
    [impactRoutes],
  );
  const impacts = useRouteImpacts({
    routes: impactRoutes,
    destination,
    vehicles: garageVehicles,
    homeElectricityPrice: settings.evHomePricePerKwh,
    homeElectricityCurrency: settings.evHomeCurrency,
  });

  // The plans other modes already hold for this trip, read without fetching
  // and re-read whenever the cache changes, so a mode's duration appears as
  // soon as its plan lands.
  const cachedPlanKeys = DURATION_MODES.map((candidate) =>
    directionsQueryKey({
      ...groundRequest,
      waypoints: routeWaypoints,
      mode: candidate,
      // The pin belongs to the shown mode; the other modes were planned unpinned.
      provider: candidate === routeMode ? groundRequest.provider : undefined,
      departAt: candidate === "driving" ? departAt : undefined,
      arriveBy: candidate === "driving" ? arriveBy : undefined,
    }),
  );
  const cachedPlans = useCachedQueryData<DirectionsResult>(cachedPlanKeys);
  const cachedDuration = (candidate: TravelMode): ModeDuration | undefined => {
    if (!allWaypointsFilled) return undefined;
    const index = DURATION_MODES.indexOf(candidate);
    const route = cachedPlans[index]?.routes[0];
    return route?.duration !== undefined
      ? {
          time: formatDuration(route.duration, locale),
          contributors: contributorsForField(route, "duration"),
        }
      : undefined;
  };

  return {
    routeWaypoints,
    allWaypointsFilled,
    multiStop,
    groundRequest,
    scheduleRequest,
    evRequest,
    arrivalContext,
    directionsQuery,
    directions: planState<DirectionsResult>(directionsQuery, hasNoRoutes),
    scheduled: planState<ScheduledDirectionsResult>(scheduledQuery, hasNoRoutes),
    ev: planState<EvDirectionsResult>(evQuery, hasNoRoutes),
    displayed,
    routingAttributions,
    fastestRouteIndex,
    impacts,
    cachedDuration,
  };
}
