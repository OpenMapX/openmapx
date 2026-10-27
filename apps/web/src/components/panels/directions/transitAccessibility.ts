import type { TripItinerary, TripLeg } from "@openmapx/mobility-core/transit";

/** Presentation only: keep the provider flag intact for routing requirements. */
export function getWheelchairStatus(
  leg: TripLeg,
  itinerary?: Pick<TripItinerary, "source" | "instance">,
): "accessible" | "unconfirmed" | "inaccessible" | undefined {
  if (leg.wheelchairAccessible === true) return "accessible";
  if (leg.wheelchairAccessible !== false) return undefined;

  // MOTIS/Nigiri folds unknown GTFS trip accessibility into NOT_ACCESSIBLE.
  // Neither hosted Transitous nor self-hosted MOTIS proves a restriction here.
  const motisSources = ["mo", "ms", "transitous", "transit-motis-local"];
  const isMotis =
    motisSources.includes(itinerary?.instance ?? "") ||
    motisSources.includes(itinerary?.source ?? "") ||
    /^(mo|ms):/.test(leg.tripId ?? "");
  return isMotis ? "unconfirmed" : "inaccessible";
}
