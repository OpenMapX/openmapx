"use client";

import type { TripItinerary } from "@openmapx/mobility-core/transit";
import { useCallback, useMemo, useReducer } from "react";

/** A transit itinerary opened in details, under the plan query it came from. */
export interface TransitDetailsSelection {
  identity: string;
  itinerary: TripItinerary;
}

export interface DetailsNavigationState {
  /** The ground route open in details, by its index in the displayed result. */
  routeIndex: number | null;
  transit: TransitDetailsSelection | null;
}

export type DetailsNavigationAction =
  | { type: "openRoute"; index: number }
  | { type: "closeRoute" }
  | { type: "openTransit"; selection: TransitDetailsSelection }
  | { type: "closeTransit" }
  | { type: "leave" };

export const CLOSED_DETAILS: DetailsNavigationState = { routeIndex: null, transit: null };

/** Which details view the directions panel shows; leaving details closes both. */
export function detailsNavigationReducer(
  state: DetailsNavigationState,
  action: DetailsNavigationAction,
): DetailsNavigationState {
  switch (action.type) {
    case "openRoute":
      return { ...state, routeIndex: action.index };
    case "closeRoute":
      return state.routeIndex === null ? state : { ...state, routeIndex: null };
    case "openTransit":
      return { ...state, transit: action.selection };
    case "closeTransit":
      return state.transit === null ? state : { ...state, transit: null };
    case "leave":
      return state.routeIndex === null && state.transit === null ? state : CLOSED_DETAILS;
  }
}

export type DirectionsDetailsNavigation = ReturnType<typeof useDirectionsDetailsNavigation>;

/** The directions panel's details navigation: a ground route or a transit itinerary. */
export function useDirectionsDetailsNavigation() {
  const [state, dispatch] = useReducer(detailsNavigationReducer, CLOSED_DETAILS);
  const openRoute = useCallback((index: number) => dispatch({ type: "openRoute", index }), []);
  const closeRoute = useCallback(() => dispatch({ type: "closeRoute" }), []);
  const openTransit = useCallback(
    (selection: TransitDetailsSelection) => dispatch({ type: "openTransit", selection }),
    [],
  );
  const closeTransit = useCallback(() => dispatch({ type: "closeTransit" }), []);
  const leave = useCallback(() => dispatch({ type: "leave" }), []);
  return useMemo(
    () => ({ ...state, openRoute, closeRoute, openTransit, closeTransit, leave }),
    [state, openRoute, closeRoute, openTransit, closeTransit, leave],
  );
}
