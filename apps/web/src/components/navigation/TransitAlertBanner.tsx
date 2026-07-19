"use client";

import Box from "@mui/material/Box";
import type { ServiceAlert, TripItinerary } from "@openmapx/mobility-core/transit";
import { useTranslations } from "next-intl";
import { AlertCard } from "@/components/panels/transit/AlertCard";
import { collectActiveAlerts } from "@/lib/navigation/transitAlerts";

/** Cap so a noisy feed can't push the banner over the map. */
const MAX_CARDS = 2;

/**
 * Surfaces service alerts/disruptions for the rest of the trip during transit
 * navigation — reusing the planning {@link AlertCard} — plus a prominent
 * cancellation card when a current/upcoming ride is cancelled. Shows the most
 * severe alerts first, capped. Renders nothing when there's nothing to say.
 */
export function TransitAlertBanner({
  itinerary,
  currentLegIndex,
}: {
  itinerary: TripItinerary;
  currentLegIndex: number;
}) {
  const t = useTranslations("navigation");
  const legs = itinerary.legs;
  const alerts = collectActiveAlerts(legs, currentLegIndex);

  // A cancelled ride is the most urgent thing to say — synthesize a severe card
  // when the feed doesn't already carry an explicit alert for it.
  const cancelledLeg = legs.slice(Math.max(0, currentLegIndex)).find((l) => l.cancelled && l.route);
  const cards: ServiceAlert[] = [];
  if (cancelledLeg?.route) {
    cards.push({
      id: `cancel:${cancelledLeg.tripId ?? cancelledLeg.route.shortName}`,
      providers: [],
      severity: "severe",
      title: t("legCancelled", {
        line: cancelledLeg.route.shortName || cancelledLeg.route.longName || "",
      }),
      affectedRouteIds: [],
      affectedStopIds: [],
      activePeriods: [],
    });
  }
  cards.push(...alerts);

  const shown = cards.slice(0, MAX_CARDS);
  if (shown.length === 0) return null;

  return (
    <Box
      sx={{
        pointerEvents: "auto",
        display: "flex",
        flexDirection: "column",
        gap: 0.5,
        borderRadius: 2,
        overflow: "hidden",
      }}
    >
      {shown.map((alert) => (
        <AlertCard key={alert.id} alert={alert} expandable={false} />
      ))}
    </Box>
  );
}
