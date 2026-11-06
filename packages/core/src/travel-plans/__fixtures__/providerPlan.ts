import type { TripItinerary } from "@openmapx/mobility-core/transit";
import type { ResolvedTravelPlan, TravelPlanResolutionOptions } from "../resolve";
import { transitItineraryKey } from "../../utils/transitItineraryKey";

/** Synthetic provider data deliberately differs from the DB share. */
export function providerPlanSelection(options: TravelPlanResolutionOptions = {}): ResolvedTravelPlan {
  const itinerary: TripItinerary = {
    id: "provider-trip", source: "ms", instance: "ms", datasetEpoch: "E",
    startTime: "2026-11-06T20:23:00.000Z", endTime: "2026-11-06T21:16:00.000Z",
    duration: 3180, transfers: 0, walkDistance: 0, distanceMeters: 71000,
    refreshToken: "ordinary-refresh-token", fare: { source: "provider", transfers: [] },
    legs: [{ mode: "rail", tripId: "ms:10935", tripShortName: "10935",
      route: { shortName: "RE9", longName: "Provider route" },
      startTime: "2026-11-06T20:23:00.000Z", endTime: "2026-11-06T21:16:00.000Z",
      scheduledStartTime: "2026-11-06T20:18:00.000Z", scheduledEndTime: "2026-11-06T21:11:00.000Z",
      from: { stopId: "ms:a", name: "Provider Aachen", lat: 50.768, lng: 6.091, platformCode: "17" },
      to: { stopId: "ms:b", name: "Provider Koeln", lat: 50.943, lng: 6.959, platformCode: "8" },
      geometry: { type: "LineString", coordinates: [[6.091, 50.768], [6.5, 50.9], [6.959, 50.943]] },
    }],
  };
  return {
    query: { kind: "search", params: {
      origin: [6.091, 50.768], destination: [6.959, 50.943], time: "2026-11-06T20:16:00.000Z",
      numItineraries: 3, transferBuffer: "standard", capabilityEpoch: "E",
      wheelchairRequired: options.wheelchairRequired ?? false,
      requireBikeTransport: options.requireBikeTransport ?? false,
      bikeHillPreference: options.bikeHillPreference ?? "default",
    } },
    plan: { data: { from: itinerary.legs[0].from, to: itinerary.legs[0].to, itineraries: [itinerary], provider: "ms", source: "transit-motis-local", datasetEpoch: "E" },
      attributions: [], freshness: { fetchedAt: "2026-11-06T20:00:00Z", hasRealtimeData: true, isStale: false } },
    selectedItineraryKey: transitItineraryKey(itinerary, "ms"),
  };
}
