import type { TripLeg, VehicleJourneyStop } from "@openmapx/mobility-core/transit";

export interface TransitTime {
  scheduledAt?: string;
  expectedAt?: string;
}

type StopTime = Pick<
  VehicleJourneyStop,
  "scheduledDeparture" | "expectedDeparture" | "scheduledArrival" | "expectedArrival"
>;
export type TransitTimeEvent = "departure" | "arrival";

function validTime(value?: string): string | undefined {
  return value && Number.isFinite(Date.parse(value)) ? value : undefined;
}

/** Compare the minute boundaries used by the displayed clocks, including midnight. */
export function transitDelayMinutes(time: TransitTime): number | undefined {
  const scheduled = validTime(time.scheduledAt);
  const expected = validTime(time.expectedAt);
  if (!scheduled || !expected) return undefined;
  return Math.floor(Date.parse(expected) / 60_000) - Math.floor(Date.parse(scheduled) / 60_000);
}

/** Keep arrival and departure evidence paired, especially at stops with dwell time. */
export function stopTransitTime(
  stop: StopTime,
  event: TransitTimeEvent = "departure",
): TransitTime {
  const departure = event === "departure" && !!validTime(stop.scheduledDeparture);
  return {
    scheduledAt: validTime(departure ? stop.scheduledDeparture : stop.scheduledArrival),
    expectedAt: validTime(departure ? stop.expectedDeparture : stop.expectedArrival),
  };
}

/** The selected leg owns its endpoints. Captured stops only fill an invalid endpoint. */
export function legTransitTime(
  leg: Pick<
    TripLeg,
    "startTime" | "endTime" | "scheduledStartTime" | "scheduledEndTime" | "realtime"
  >,
  event: TransitTimeEvent = "departure",
  capturedStop?: StopTime,
): TransitTime {
  const effective = validTime(event === "departure" ? leg.startTime : leg.endTime);
  if (!effective) return capturedStop ? stopTransitTime(capturedStop, event) : {};
  const scheduledAt = validTime(
    event === "departure" ? leg.scheduledStartTime : leg.scheduledEndTime,
  );
  if (!scheduledAt) return leg.realtime ? { expectedAt: effective } : { scheduledAt: effective };
  return {
    scheduledAt,
    expectedAt:
      leg.realtime || Date.parse(effective) !== Date.parse(scheduledAt) ? effective : undefined,
  };
}
