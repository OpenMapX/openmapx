"use client";

import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import { useDepartures } from "@openmapx/core";
import { useTranslations } from "next-intl";
import { DepartureRow } from "@/components/panels/transit/DepartureRow";

/** How many upcoming departures to list. */
const LIMIT = 4;

/**
 * Live departure board for the stop the rider is walking to / waiting at, shown
 * in the journey sheet while heading to a boarding point. The service they're
 * catching is floated to the top; the rest give context ("is mine next?"),
 * reusing the planning {@link DepartureRow}. Polls every 60s via the hook.
 */
export function TransitBoardingDepartures({
  stopId,
  stopName,
  targetTripId,
  targetRouteShortName,
}: {
  stopId: string;
  stopName: string;
  targetTripId?: string;
  targetRouteShortName?: string;
}) {
  const t = useTranslations("navigation");
  const { data: departures } = useDepartures(stopId, 45);
  if (!departures || departures.length === 0) return null;

  // Put the service the rider is catching first, then the soonest others.
  const isTarget = (tripId: string, route: string) =>
    (targetTripId && tripId === targetTripId) ||
    (!!targetRouteShortName && route === targetRouteShortName);
  const ordered = [...departures].sort((a, b) => {
    const at = isTarget(a.tripId, a.route.shortName) ? 0 : 1;
    const bt = isTarget(b.tripId, b.route.shortName) ? 0 : 1;
    return at - bt;
  });

  return (
    <Box>
      <Typography
        variant="overline"
        sx={{ display: "block", px: 2, pt: 1, color: "text.secondary" }}
        noWrap
      >
        {t("departuresAt", { stop: stopName })}
      </Typography>
      {ordered.slice(0, LIMIT).map((dep) => (
        <DepartureRow key={`${dep.tripId}-${dep.scheduledAt}`} departure={dep} showPlatform />
      ))}
    </Box>
  );
}
