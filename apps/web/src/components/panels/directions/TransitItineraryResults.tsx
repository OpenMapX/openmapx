"use client";

import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Divider from "@mui/material/Divider";
import Typography from "@mui/material/Typography";
import { useDirectionsStore } from "@openmapx/core";
import { transitItineraryFingerprint } from "@openmapx/core/navigation";
import { snapshotContributors } from "@openmapx/mobility-core/contributors";
import { useTranslations } from "next-intl";
import { TransitDetailsView } from "@/components/panels/directions/TransitDetailsView";
import { TransitItineraryCard } from "@/components/panels/directions/TransitRouteView";
import { useMobileSheet } from "@/components/panels/sheet/sheetState";
import { AttributionDetailsGroup } from "@/components/ui/AttributionDetailsGroup";
import { AttributionStrip } from "@/components/ui/AttributionStrip";
import { planState, type RouteRecoveryActions, RouteResultStates } from "./RouteResultStates";
import { findTransitItinerary } from "./transitPlanPages";
import type { DirectionsDetailsNavigation } from "./useDirectionsDetailsNavigation";
import type { TransitDirectionsPlan } from "./useTransitDirectionsPlan";
import { useTripTimeZones } from "./useTripTimeZones";

type TransitItinerary = TransitDirectionsPlan["itineraries"][number];

/** The lowest finite CO₂ figure among the itineraries, when at least two can be compared. */
function lowestCo2Grams(itineraries: readonly TransitItinerary[]): number | null {
  const values = itineraries
    .map((itinerary) => itinerary.co2Grams)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  return values.length < 2 ? null : Math.min(...values);
}

/** The itinerary whose details are open, when it belongs to the current plan. */
export function openTransitItinerary(
  transit: TransitDirectionsPlan,
  details: DirectionsDetailsNavigation,
): TransitItinerary | undefined {
  if (details.transit?.identity !== transit.queryIdentity) return undefined;
  const index = findTransitItinerary(transit.itineraries, details.transit.itinerary);
  return index >= 0 ? transit.itineraries[index] : undefined;
}

/** The trip's ends and the zones their times render in. */
function useTripEnds() {
  const waypoints = useDirectionsStore((s) => s.waypoints);
  const origin = waypoints[0];
  const destination = waypoints.at(-1);
  const zones = useTripTimeZones(origin?.coords ?? null, destination?.coords ?? null);
  return { originLabel: origin?.label ?? "", destinationLabel: destination?.label ?? "", zones };
}

interface TransitItineraryResultsProps {
  transit: TransitDirectionsPlan;
  recovery: RouteRecoveryActions;
  details: DirectionsDetailsNavigation;
  onNotify: (message: string) => void;
}

/** A transit plan's itineraries, with paging to earlier and later connections. */
export function TransitItineraryResults({
  transit,
  recovery,
  details,
  onNotify,
}: TransitItineraryResultsProps) {
  const t = useTranslations("directions");
  const tc = useTranslations("common");
  const { snapTo } = useMobileSheet();
  const activeItineraryIndex = useDirectionsStore((s) => s.activeItineraryIndex);
  const { zones } = useTripEnds();
  const { itineraries, paging } = transit;
  const loading = transit.planQuery.isLoading;
  const plan = planState(
    transit.planQuery,
    (data) => itineraries.length === 0 || (data.itineraries.length === 0 && !paging.isPage),
  );
  const lowestCo2 = lowestCo2Grams(itineraries);

  const replaceRefreshed = (
    itinerary: TransitItinerary,
    updated: TransitItinerary,
    changed: boolean,
    fallbackOccurred: boolean,
  ) => {
    const directions = useDirectionsStore.getState();
    const current = directions.transitItineraries;
    if (!current.includes(itinerary)) return;
    const retained =
      !fallbackOccurred &&
      transitItineraryFingerprint(updated) === transitItineraryFingerprint(itinerary)
        ? { ...updated, regionalOnly: itinerary.regionalOnly }
        : updated;
    directions.setTransitItineraries(
      current.map((candidate) => (candidate === itinerary ? retained : candidate)),
    );
    if (changed || fallbackOccurred) {
      onNotify(fallbackOccurred ? t("connectionReplanned") : t("connectionUpdated"));
    }
  };

  return (
    <RouteResultStates state={plan} recovery={recovery}>
      {itineraries.map((itin, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: itineraries have no stable id
        <Box key={i}>
          <TransitItineraryCard
            itinerary={itin}
            active={i === activeItineraryIndex}
            isLowestCo2={lowestCo2 !== null && itin.co2Grams === lowestCo2}
            replanOptions={transit.replanOptions}
            originTimeZone={zones.originTimeZone}
            destinationTimeZone={zones.destinationTimeZone}
            onSelect={() => {
              useDirectionsStore.getState().setActiveItineraryIndex(i);
              snapTo("peek");
            }}
            onDetails={() =>
              details.openTransit({ identity: transit.queryIdentity, itinerary: itin })
            }
            onRefreshed={(updated, changed, fallbackOccurred) =>
              replaceRefreshed(itin, updated, changed, fallbackOccurred)
            }
          />
          {i < itineraries.length - 1 && <Divider />}
        </Box>
      ))}
      {zones.destinationOffsetLabel && (
        <Typography sx={{ fontSize: 11, color: "text.secondary", px: 2, pb: 1 }}>
          {t("arrivalInDestinationTime")}
        </Typography>
      )}
      {(paging.previousToken || paging.nextToken) && (
        <Box sx={{ px: 2, py: 1, borderTop: "1px solid", borderColor: "divider" }}>
          <Box sx={{ display: "flex", justifyContent: "space-between", gap: 1 }}>
            <Button
              size="small"
              disabled={!paging.previousToken || loading}
              onClick={paging.loadPrevious}
            >
              {t("earlierConnections")}
            </Button>
            <Button size="small" disabled={!paging.nextToken || loading} onClick={paging.loadNext}>
              {t("laterConnections")}
            </Button>
          </Box>
        </Box>
      )}
      <AttributionStrip
        attributions={transit.attributions}
        variant="panel-header"
        label={tc("dataSources")}
      />
    </RouteResultStates>
  );
}

interface TransitItineraryDetailsProps {
  transit: TransitDirectionsPlan;
  itinerary: TransitItinerary;
  details: DirectionsDetailsNavigation;
}

/** One itinerary's legs, with its alternatives and the sources that supplied it. */
export function TransitItineraryDetails({
  transit,
  itinerary,
  details,
}: TransitItineraryDetailsProps) {
  const tc = useTranslations("common");
  const { originLabel, destinationLabel, zones } = useTripEnds();
  const lowestCo2 = lowestCo2Grams(transit.itineraries);
  return (
    <AttributionDetailsGroup placement="footer" label={tc("dataSources")}>
      <TransitDetailsView
        itinerary={itinerary}
        isLowestCo2={lowestCo2 !== null && itinerary.co2Grams === lowestCo2}
        originLabel={originLabel}
        destinationLabel={destinationLabel}
        provider={transit.planQuery.data?.provider}
        attributions={snapshotContributors(itinerary.contributors ?? [])}
        originTimeZone={zones.originTimeZone}
        destinationTimeZone={zones.destinationTimeZone}
        onSelectItinerary={(parent, candidate) => {
          const selected = transit.selectAlternative(parent, candidate);
          if (selected)
            details.openTransit({ identity: transit.queryIdentity, itinerary: selected });
        }}
        onBack={details.closeTransit}
      />
    </AttributionDetailsGroup>
  );
}
