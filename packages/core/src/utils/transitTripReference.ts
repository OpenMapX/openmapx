import type { TransitTripReference, TripItinerary } from "@openmapx/mobility-core/transit";

/** Walks may connect the trips; every ridden leg must retain exact provider identity. */
export function itineraryMatchesTransitReference(
  itinerary: TripItinerary,
  reference: TransitTripReference,
): boolean {
  const legs = itinerary.legs.filter((leg) => leg.mode !== "walking");
  return (
    legs.length === reference.legs.length &&
    legs.every((leg, i) => {
      const r = reference.legs[i];
      return (
        leg.tripId === r.tripId &&
        leg.from.stopId === r.fromStopId &&
        leg.to.stopId === r.toStopId &&
        Date.parse(leg.scheduledStartTime ?? "") === Date.parse(r.scheduledDeparture) &&
        Date.parse(leg.scheduledEndTime ?? "") === Date.parse(r.scheduledArrival)
      );
    })
  );
}
