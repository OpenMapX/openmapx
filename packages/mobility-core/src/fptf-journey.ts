import type { TripItinerary, TripLeg, TripPlan } from "./types/transit.js";

export interface FptfJourneyLeg {
  walking?: boolean;
  distance?: number;
}

export interface FptfJourney<RawLeg extends FptfJourneyLeg> {
  legs?: RawLeg[];
}

export interface TripPlanEndpoints {
  fromLat: number;
  fromLng: number;
  toLat: number;
  toLng: number;
}

export function journeysToTripPlan<RawLeg extends FptfJourneyLeg>(
  journeys: Array<FptfJourney<RawLeg>>,
  endpoints: TripPlanEndpoints,
  mapLeg: (leg: RawLeg) => TripLeg,
): TripPlan {
  const itineraries: TripItinerary[] = journeys.map((journey) => {
    const rawLegs = journey.legs ?? [];
    const legs = rawLegs.map((leg) => mapLeg(leg));
    const startTime = legs[0]?.startTime ?? "";
    const endTime = legs[legs.length - 1]?.endTime ?? "";
    const durationMs =
      startTime && endTime ? new Date(endTime).getTime() - new Date(startTime).getTime() : 0;
    const transfers = Math.max(0, legs.filter((leg) => leg.route !== undefined).length - 1);
    const walkDistance = rawLegs
      .filter((leg) => leg.walking === true)
      .reduce((sum, leg) => sum + (leg.distance ?? 0), 0);

    return {
      duration: Math.round(durationMs / 1_000),
      startTime,
      endTime,
      transfers,
      walkDistance: Math.round(walkDistance),
      legs,
    };
  });
  const firstLeg = itineraries[0]?.legs[0];
  const firstItinerary = itineraries[0];
  const lastLeg = firstItinerary?.legs[firstItinerary.legs.length - 1];

  return {
    from: {
      name: firstLeg?.from.name ?? "",
      lat: firstLeg?.from.lat ?? endpoints.fromLat,
      lng: firstLeg?.from.lng ?? endpoints.fromLng,
    },
    to: {
      name: lastLeg?.to.name ?? "",
      lat: lastLeg?.to.lat ?? endpoints.toLat,
      lng: lastLeg?.to.lng ?? endpoints.toLng,
    },
    itineraries,
  };
}
