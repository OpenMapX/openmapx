"use client";

import Box from "@mui/material/Box";
import Divider from "@mui/material/Divider";
import { timeZoneAt, useDirectionsStore, useSettingsStore } from "@openmapx/core";
import { useIntegrationRegistry } from "@openmapx/integration-framework/react";
import { useTranslations } from "next-intl";
import { useShallow } from "zustand/react/shallow";
import { DetailsView } from "@/components/panels/directions/DetailsView";
import { RouteCard } from "@/components/panels/directions/RouteCard";
import { RouteStopSearch } from "@/components/panels/directions/RouteStopSearch";
import { TripScheduleCard } from "@/components/panels/directions/TripScheduleCard";
import { useMobileSheet } from "@/components/panels/sheet/sheetState";
import { AttributionStrip } from "@/components/ui/AttributionStrip";
import { routeAttributions } from "@/lib/routeAttributions";
import { isTimedGroundMode } from "./directionsRequests";
import { MultiStopRouteSummary } from "./MultiStopRouteSummary";
import { type RouteRecoveryActions, RouteResultStates } from "./RouteResultStates";
import type { DirectionsDetailsNavigation } from "./useDirectionsDetailsNavigation";
import type { GroundDirectionsPlan } from "./useGroundDirectionsPlan";

interface GroundRouteResultsProps {
  ground: GroundDirectionsPlan;
  recovery: RouteRecoveryActions;
  details: DirectionsDetailsNavigation;
}

/** A road trip's answer: a scheduled trip, one multi-stop route, or alternative routes. */
export function GroundRouteResults({ ground, recovery, details }: GroundRouteResultsProps) {
  const { scheduleRequest } = ground;
  const scheduledData = ground.scheduled.data;
  const data = ground.directions.data;
  const t = useTranslations("directions");
  const tc = useTranslations("common");
  const { snapTo } = useMobileSheet();
  const units = useSettingsStore((s) => s.units);
  const { waypoints, mode, activeRouteIndex } = useDirectionsStore(
    useShallow((s) => ({
      waypoints: s.waypoints,
      mode: s.mode,
      activeRouteIndex: s.activeRouteIndex,
    })),
  );

  const routingCredits = (
    <AttributionStrip
      attributions={ground.routingAttributions}
      variant="panel-header"
      label={tc("dataSources")}
    />
  );
  const routeCardImpact = (i: number) => ({
    impact: ground.impacts.impacts[i],
    impactUnavailableReason: ground.impacts.unavailableReason,
    vehicles: ground.impacts.compatibleVehicles,
    onUpdateAssumptions: ground.impacts.updateAssumptions,
  });

  if (scheduleRequest) {
    const destination = waypoints.at(-1)?.coords ?? null;
    return (
      <RouteResultStates state={ground.scheduled} recovery={recovery}>
        {scheduledData && (
          <>
            {scheduledData.routes.map((route, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: routes have no stable id
              <Box key={i}>
                <RouteCard
                  route={route}
                  index={i}
                  active
                  selectionKind="peek"
                  isFastest={i === ground.fastestRouteIndex}
                  onSelect={() => snapTo("peek")}
                  onDetails={() => details.openRoute(i)}
                  units={units}
                  arrivalContext={{
                    kind: "scheduled",
                    arrival: scheduledData.schedule.arrival,
                    destinationTimeZone: destination
                      ? timeZoneAt(destination[1], destination[0])
                      : null,
                  }}
                  provider={scheduledData.provider}
                  roadConditionImpact={scheduledData.roadConditionImpact}
                  {...routeCardImpact(i)}
                />
              </Box>
            ))}
            <Divider />
            <TripScheduleCard
              schedule={scheduledData.schedule}
              fidelity={scheduledData.fidelity}
              warnings={scheduledData.warnings}
              waypointLabels={waypoints.map((wp) => wp.label)}
            />
            {routingCredits}
          </>
        )}
      </RouteResultStates>
    );
  }

  const stopSearchRoute =
    isTimedGroundMode(mode) && data ? (data.routes[activeRouteIndex] ?? data.routes[0]) : undefined;
  // Under the route cards of a plain driving or motorcycle trip, with or
  // without stops; the EV, scheduled and ride branches never render it.
  const stopSearch =
    stopSearchRoute && data && (stopSearchRoute.geometry?.length ?? 0) >= 2 ? (
      <>
        <Divider />
        <RouteStopSearch
          route={stopSearchRoute}
          provider={data.provider}
          request={ground.groundRequest}
          units={units}
        />
      </>
    ) : null;

  return (
    <RouteResultStates state={ground.directions} recovery={recovery}>
      {data?.routes[0] &&
        (waypoints.length > 2 ? (
          <>
            <MultiStopRouteSummary
              route={data.routes[0]}
              waypoints={waypoints}
              units={units}
              onDetails={() => details.openRoute(0)}
            />
            {stopSearch}
            {routingCredits}
          </>
        ) : (
          <>
            <Box role="radiogroup" aria-label={t("routes")}>
              {data.routes.map((route, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: routes have no stable id
                <Box key={i}>
                  <RouteCard
                    route={route}
                    index={i}
                    active={i === activeRouteIndex}
                    isFastest={i === ground.fastestRouteIndex}
                    onSelect={() => {
                      useDirectionsStore.getState().setActiveRouteIndex(i);
                      snapTo("peek");
                    }}
                    onDetails={() => details.openRoute(i)}
                    units={units}
                    arrivalContext={ground.arrivalContext}
                    alternatives={data.routes.filter((_, idx) => idx !== i)}
                    provider={data.provider}
                    roadConditionImpact={data.roadConditionImpact}
                    {...routeCardImpact(i)}
                  />
                  {i < data.routes.length - 1 && <Divider />}
                </Box>
              ))}
            </Box>
            {stopSearch}
            {routingCredits}
          </>
        ))}
    </RouteResultStates>
  );
}

type DisplayedRoutes = NonNullable<GroundDirectionsPlan["displayed"]>;

interface GroundRouteDetailsProps {
  route: DisplayedRoutes["routes"][number];
  provider: DisplayedRoutes["provider"] | undefined;
  onBack: () => void;
}

/** The turn-by-turn view of one planned road route. */
export function GroundRouteDetails({ route, provider, onBack }: GroundRouteDetailsProps) {
  const registry = useIntegrationRegistry();
  const units = useSettingsStore((s) => s.units);
  const waypoints = useDirectionsStore((s) => s.waypoints);
  return (
    <DetailsView
      route={route}
      attributions={routeAttributions(registry, provider, route)}
      originLabel={waypoints[0]?.label ?? ""}
      destinationLabel={waypoints.at(-1)?.label ?? ""}
      waypointLabels={waypoints.map((wp) => wp.label)}
      units={units}
      onBack={onBack}
    />
  );
}
