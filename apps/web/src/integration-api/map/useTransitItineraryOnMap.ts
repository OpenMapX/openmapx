"use client";

import { type DirectionsState, useDirectionsStore } from "@openmapx/core";

/**
 * True when the directions planner is drawing a chosen transit itinerary — the
 * same condition `TransitItineraryLayer` draws under. Transit-network overlays
 * read it to step back while a trip is on the map, so the network they paint
 * does not bury the one route the traveller picked.
 */
export function selectTransitItineraryOnMap(state: DirectionsState): boolean {
  if (state.mode !== "transit") return false;
  const itinerary = state.transitItineraries[state.activeItineraryIndex];
  return (itinerary?.legs.length ?? 0) > 0;
}

export function useTransitItineraryOnMap(): boolean {
  return useDirectionsStore(selectTransitItineraryOnMap);
}
