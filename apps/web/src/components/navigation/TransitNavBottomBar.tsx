"use client";

import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Typography from "@mui/material/Typography";
import { formatDuration, useVehicleJourney } from "@openmapx/core";
import type { TripItinerary, TripLeg, VehicleJourneyStop } from "@openmapx/mobility-core/transit";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { useDateTimeFormat } from "@/integration-api/runtime/useDateTimeFormat";
import { useMobileRuntime } from "@/lib/mobile/useMobileRuntime";
import { useNavigationMutations } from "@/lib/mobile/useNavigationMutations";
import { useNow } from "@/lib/useNow";

/** Seconds from `nowMs` until `arrivalMs`, clamped at zero (never negative). */
export function transitRemainingSeconds(arrivalMs: number, nowMs: number): number {
  if (Number.isNaN(arrivalMs)) return 0;
  return Math.max(0, (arrivalMs - nowMs) / 1000);
}

/** The realtime arrival fields of a live journey stop that the delay math reads. */
type JourneyStopArrival = Pick<
  VehicleJourneyStop,
  "stopId" | "scheduledArrival" | "expectedArrival" | "delaySeconds"
>;

/**
 * Live arrival delay (ms) for the current transit leg, relative to what the plan
 * assumed: the alight stop's realtime `expectedArrival` minus the leg's planned
 * `endTime`. Positive = running late, negative = ahead. Measuring against the
 * plan (not the GTFS schedule) means any delay already baked into the itinerary
 * at plan time isn't double-counted — this only reflects drift since then. Zero
 * when there's no live data, no matching stop, or unparseable times (e.g. on a
 * walking leg with no `tripId`/journey).
 */
export function liveArrivalDelayMs(
  stops: JourneyStopArrival[] | undefined,
  alightStopId: string | undefined,
  plannedLegEndIso: string | undefined,
): number {
  if (!stops || !alightStopId || !plannedLegEndIso) return 0;
  const stop = stops.find((s) => s.stopId === alightStopId);
  if (!stop) return 0;
  const expectedMs = stop.expectedArrival
    ? new Date(stop.expectedArrival).getTime()
    : stop.scheduledArrival
      ? new Date(stop.scheduledArrival).getTime() + (stop.delaySeconds ?? 0) * 1000
      : Number.NaN;
  const plannedMs = new Date(plannedLegEndIso).getTime();
  if (Number.isNaN(expectedMs) || Number.isNaN(plannedMs)) return 0;
  return expectedMs - plannedMs;
}

/** Compact transit summary. Navigation calculations and command authority stay shared. */
export function TransitNavBottomBar({
  itinerary,
  currentLeg,
  menuToggle,
}: {
  itinerary: TripItinerary;
  currentLeg?: TripLeg;
  /** Trailing control that reveals the menu (a chevron on desktop; omitted on
   * mobile, where the sheet is dragged up instead). */
  menuToggle?: ReactNode;
}) {
  const t = useTranslations("navigation");
  const fmt = useDateTimeFormat();
  const { endNavigation } = useNavigationMutations();
  const now = useNow(1000);
  const { browserAuthority } = useMobileRuntime();
  const { data: journey } = useVehicleJourney(
    browserAuthority ? (currentLeg?.tripId ?? null) : null,
  );

  const delayMs = liveArrivalDelayMs(journey?.stops, currentLeg?.to.stopId, currentLeg?.endTime);
  const arrivalMs = new Date(itinerary.endTime).getTime() + delayMs;
  const durationRemaining = transitRemainingSeconds(arrivalMs, now);
  const delayMinutes = delayMs >= 60_000 ? Math.round(delayMs / 60_000) : 0;

  return (
    <Box
      sx={{
        display: "flex",
        alignItems: "center",
        gap: 1.5,
        px: 2,
        py: 1.25,
        borderTop: "1px solid",
        borderColor: "divider",
      }}
    >
      <Button
        color="error"
        variant="contained"
        disableElevation
        onClick={() => void endNavigation()}
        sx={{ minHeight: 44, flexShrink: 0, px: 2.5, borderRadius: "999px" }}
      >
        {t("end")}
      </Button>
      <Box sx={{ flex: 1, minWidth: 0, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
        <Typography variant="h6" sx={{ fontWeight: 700, lineHeight: 1.25 }}>
          {formatDuration(durationRemaining)}
        </Typography>
        <Typography
          variant="caption"
          color="text.secondary"
          component="div"
          sx={{ display: "flex", flexWrap: "wrap", justifyContent: "flex-end", columnGap: 0.75 }}
        >
          <span>{t("arriveAt", { time: fmt.time(arrivalMs) })}</span>
          {delayMinutes >= 1 && (
            <Box component="span" sx={{ color: "error.main", fontWeight: 700 }}>
              {t("delayMinutes", { minutes: delayMinutes })}
            </Box>
          )}
        </Typography>
      </Box>
      {menuToggle}
    </Box>
  );
}
