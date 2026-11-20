"use client";

import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import { useDirectionsStore } from "@openmapx/core";
import { useTranslations } from "next-intl";
import { useShallow } from "zustand/react/shallow";
import { EvPlanCard } from "@/components/panels/directions/EvPlanCard";
import { EvVehiclePanel } from "@/components/panels/directions/EvVehiclePanel";
import { FlightPanel } from "@/components/panels/directions/FlightPanel";
import { RidePanel } from "@/components/panels/directions/RidePanel";
import { TransitChainView } from "@/components/panels/directions/TransitChainView";
import { GroundRouteResults } from "./GroundRouteResults";
import {
  NoRoutesFound,
  planState,
  type RouteRecoveryActions,
  RouteResultStates,
} from "./RouteResultStates";
import { TransitItineraryResults } from "./TransitItineraryResults";
import type { DirectionsDetailsNavigation } from "./useDirectionsDetailsNavigation";
import type { GroundDirectionsPlan } from "./useGroundDirectionsPlan";
import type { TransitDirectionsPlan } from "./useTransitDirectionsPlan";

interface DirectionsResultsProps {
  ground: GroundDirectionsPlan;
  transit: TransitDirectionsPlan;
  recovery: RouteRecoveryActions;
  details: DirectionsDetailsNavigation;
  onNotify: (message: string) => void;
}

/** The answer area under the trip form, for the active mode. */
export function DirectionsResults({
  ground,
  transit,
  recovery,
  details,
  onNotify,
}: DirectionsResultsProps) {
  const t = useTranslations("directions");
  const { mode, isEvMode, waypoints } = useDirectionsStore(
    useShallow((s) => ({ mode: s.mode, isEvMode: s.isEvMode, waypoints: s.waypoints })),
  );

  if (mode === "flying") return <FlightPanel />;

  if (mode === "ride") {
    // Ride mode plans the road route like driving; only its results area differs.
    const route = ground.directionsQuery.isError ? undefined : ground.directions.data?.routes[0];
    return (
      <>
        {ground.allWaypointsFilled && (
          <RouteResultStates state={ground.directions} recovery={recovery} />
        )}
        <RidePanel
          route={
            route ? { distanceMeters: route.distance, durationSeconds: route.duration } : undefined
          }
        />
      </>
    );
  }

  if (!ground.allWaypointsFilled) {
    return (
      <Box sx={{ px: 2, py: 3, textAlign: "center" }}>
        <Typography variant="body2" sx={{ color: "text.secondary" }}>
          {t("chooseOrigin")}
        </Typography>
      </Box>
    );
  }

  if (isEvMode) {
    return (
      <>
        <EvVehiclePanel />
        {ground.evRequest && (
          <RouteResultStates state={ground.ev} recovery={recovery}>
            {ground.ev.data && (
              <EvPlanCard
                result={ground.ev.data}
                onRetryWithoutNetworkRestriction={() =>
                  useDirectionsStore.getState().setEvForceNonExclusive(true)
                }
              />
            )}
          </RouteResultStates>
        )}
      </>
    );
  }

  if (transit.isChained) {
    const chain = planState(transit.chainQuery, () => false);
    return (
      <RouteResultStates state={chain} recovery={recovery}>
        {chain.data && (
          <>
            {chain.data.segments.length === 0 && <NoRoutesFound actions={recovery} />}
            <TransitChainView plan={chain.data} waypointLabels={waypoints.map((wp) => wp.label)} />
          </>
        )}
      </RouteResultStates>
    );
  }

  if (mode === "transit") {
    return (
      <TransitItineraryResults
        transit={transit}
        recovery={recovery}
        details={details}
        onNotify={onNotify}
      />
    );
  }

  return <GroundRouteResults ground={ground} recovery={recovery} details={details} />;
}
