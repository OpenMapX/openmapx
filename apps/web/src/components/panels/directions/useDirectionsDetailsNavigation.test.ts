import type { TripItinerary } from "@openmapx/mobility-core/transit";
import { describe, expect, it } from "vitest";
import { CLOSED_DETAILS, detailsNavigationReducer } from "./useDirectionsDetailsNavigation";

const itinerary = { duration: 600, legs: [] } as unknown as TripItinerary;

describe("detailsNavigationReducer", () => {
  it("opens and closes a ground route and a transit itinerary independently", () => {
    const route = detailsNavigationReducer(CLOSED_DETAILS, { type: "openRoute", index: 2 });
    expect(route).toEqual({ routeIndex: 2, transit: null });
    const both = detailsNavigationReducer(route, {
      type: "openTransit",
      selection: { identity: "q1", itinerary },
    });
    expect(both.transit).toEqual({ identity: "q1", itinerary });
    expect(detailsNavigationReducer(both, { type: "closeTransit" })).toEqual(route);
    expect(detailsNavigationReducer(route, { type: "closeRoute" })).toEqual(CLOSED_DETAILS);
  });

  it("leaves both details views at once, and keeps the state when nothing is open", () => {
    const open = { routeIndex: 0, transit: { identity: "q1", itinerary } };
    expect(detailsNavigationReducer(open, { type: "leave" })).toBe(CLOSED_DETAILS);
    expect(detailsNavigationReducer(CLOSED_DETAILS, { type: "leave" })).toBe(CLOSED_DETAILS);
    expect(detailsNavigationReducer(CLOSED_DETAILS, { type: "closeRoute" })).toBe(CLOSED_DETAILS);
  });
});
