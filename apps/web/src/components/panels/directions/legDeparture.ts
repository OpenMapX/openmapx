import { contributorsForField, snapshotContributors } from "@openmapx/mobility-core/contributors";
import type { MergedDeparture, TripLeg } from "@openmapx/mobility-core/transit";

/**
 * Present a planned transit leg as the departure it boards, so trip detail shows
 * it the way a departure board would: the vehicle's headsign, the planned time
 * with any realtime change, the boarding platform, cancellation and occupancy.
 */
export function legToMergedDeparture(leg: TripLeg, provider?: string): MergedDeparture {
  const scheduledAt = leg.scheduledStartTime ?? leg.startTime;
  const changed = leg.scheduledStartTime !== undefined && leg.startTime !== leg.scheduledStartTime;
  const delayMs = changed ? Date.parse(leg.startTime) - Date.parse(scheduledAt) : Number.NaN;
  return {
    contributors: snapshotContributors(
      ...[
        "route",
        "mode",
        "from",
        "to",
        "startTime",
        "scheduledStartTime",
        "headsign",
        "cancelled",
        "occupancy",
      ].map((field) => contributorsForField(leg, field)),
    ),
    tripId: leg.tripId ?? "",
    route: {
      id: leg.routeId ?? "",
      shortName: leg.route?.shortName ?? "",
      longName: leg.route?.longName ?? "",
      mode: leg.mode,
      color: leg.route?.color,
    },
    // The vehicle's destination sign, not where this traveler gets off.
    headsign: leg.headsign ?? leg.to.name,
    scheduledAt,
    ...(changed ? { expectedAt: leg.startTime } : {}),
    ...(Number.isFinite(delayMs) ? { delaySeconds: Math.round(delayMs / 1000) } : {}),
    ...(leg.from.platformCode ? { platform: leg.from.platformCode } : {}),
    ...(leg.from.scheduledPlatformCode
      ? { scheduledPlatform: leg.from.scheduledPlatformCode }
      : {}),
    ...(leg.cancelled ? { canceled: true } : {}),
    ...(leg.occupancy ? { occupancy: leg.occupancy } : {}),
    providers: provider ? [provider] : [],
  };
}
