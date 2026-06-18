"use client";

import Box from "@mui/material/Box";
import { useNavigationStore, useVehicleJourney } from "@openmapx/core";
import type { TripItinerary, TripLeg, VehicleJourneyStop } from "@openmapx/mobility-core/transit";
import { useTranslations } from "next-intl";
import { useDateTimeFormat } from "@/lib/useDateTimeFormat";
import { useNow } from "@/lib/useNow";
import { NavBottomBar } from "./NavBottomBar";

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

/**
 * Transit follow-along bottom bar. Reuses the driving {@link NavBottomBar} with
 * transit content: a live arrival countdown (instead of a static trip duration),
 * the scheduled arrival time, keep-screen-on, and End. Distance / voice /
 * overview are omitted — they don't apply to transit.
 *
 * The arrival is delay-aware: it tracks the realtime delay of the vehicle the
 * traveller is on (via the live journey for `currentLeg.tripId`) so the
 * countdown grows as the bus runs late, with a "+N min" chip on the arrival line.
 */
export function TransitNavBottomBar({
  itinerary,
  currentLeg,
}: {
  itinerary: TripItinerary;
  currentLeg?: TripLeg;
}) {
  const t = useTranslations("navigation");
  const fmt = useDateTimeFormat();
  const keepScreenOn = useNavigationStore((s) => s.keepScreenOn);
  const toggleKeepScreenOn = useNavigationStore((s) => s.toggleKeepScreenOn);
  const stopNavigation = useNavigationStore((s) => s.stopNavigation);
  const now = useNow(1000);
  const { data: journey } = useVehicleJourney(currentLeg?.tripId ?? null);

  const delayMs = liveArrivalDelayMs(journey?.stops, currentLeg?.to.stopId, currentLeg?.endTime);
  const arrivalMs = new Date(itinerary.endTime).getTime() + delayMs;
  const durationRemaining = transitRemainingSeconds(arrivalMs, now);
  const delayMinutes = delayMs >= 60_000 ? Math.round(delayMs / 60_000) : 0;

  return (
    <NavBottomBar
      durationRemaining={durationRemaining}
      etaEpochMs={arrivalMs}
      keepScreenOn={keepScreenOn}
      onToggleKeepScreenOn={toggleKeepScreenOn}
      onEnd={stopNavigation}
      secondary={
        <>
          {t("arriveAt", { time: fmt.time(arrivalMs) })}
          {delayMinutes >= 1 && (
            <Box component="span" sx={{ ml: 1, color: "error.main", fontWeight: 700 }}>
              {t("delayMinutes", { minutes: delayMinutes })}
            </Box>
          )}
        </>
      }
    />
  );
}
