import { beforeEach, describe, expect, it } from "vitest";
import { useDirectionsStore } from "./directionsStore";

function reset() {
  // close() restores the initial transit-options state.
  useDirectionsStore.getState().close();
}

describe("directionsStore transit options", () => {
  beforeEach(reset);

  it("defaults to no preferred modes and 'best' route preference", () => {
    const s = useDirectionsStore.getState();
    expect(s.transitPreferredModes).toEqual([]);
    expect(s.transitRoutePreference).toBe("best");
  });

  it("toggleTransitPreferredMode adds then removes a mode", () => {
    useDirectionsStore.getState().toggleTransitPreferredMode("bus");
    expect(useDirectionsStore.getState().transitPreferredModes).toEqual(["bus"]);
    useDirectionsStore.getState().toggleTransitPreferredMode("subway");
    expect(useDirectionsStore.getState().transitPreferredModes).toEqual(["bus", "subway"]);
    useDirectionsStore.getState().toggleTransitPreferredMode("bus");
    expect(useDirectionsStore.getState().transitPreferredModes).toEqual(["subway"]);
  });

  it("toggling a preference resets the active itinerary index", () => {
    useDirectionsStore.setState({ activeItineraryIndex: 2 });
    useDirectionsStore.getState().toggleTransitPreferredMode("tram");
    expect(useDirectionsStore.getState().activeItineraryIndex).toBe(0);
  });

  it("setTransitRoutePreference updates and resets the active itinerary index", () => {
    useDirectionsStore.setState({ activeItineraryIndex: 3 });
    useDirectionsStore.getState().setTransitRoutePreference("fewerTransfers");
    expect(useDirectionsStore.getState().transitRoutePreference).toBe("fewerTransfers");
    expect(useDirectionsStore.getState().activeItineraryIndex).toBe(0);
  });

  it("keeps wheelchair and hard planner controls independent from ranking", () => {
    useDirectionsStore.getState().setWheelchairRequired(true);
    useDirectionsStore.getState().setMaxTransfers(2);
    useDirectionsStore.getState().setTransferBuffer("relaxed");
    expect(useDirectionsStore.getState()).toMatchObject({
      transitRoutePreference: "best",
      wheelchairRequired: true,
      maxTransfers: 2,
      transferBuffer: "relaxed",
    });
  });

  it("defaults deutschlandticketOnly to false and toggles it", () => {
    expect(useDirectionsStore.getState().deutschlandticketOnly).toBe(false);
    useDirectionsStore.getState().setDeutschlandticketOnly(true);
    expect(useDirectionsStore.getState().deutschlandticketOnly).toBe(true);
  });

  it("close() resets transit options back to defaults", () => {
    useDirectionsStore.getState().toggleTransitPreferredMode("train");
    useDirectionsStore.getState().setTransitRoutePreference("lessWalking");
    useDirectionsStore.getState().setDeutschlandticketOnly(true);
    useDirectionsStore.getState().close();
    const s = useDirectionsStore.getState();
    expect(s.transitPreferredModes).toEqual([]);
    expect(s.transitRoutePreference).toBe("best");
    expect(s.deutschlandticketOnly).toBe(false);
  });
});

describe("waypoint schedules", () => {
  beforeEach(() => {
    useDirectionsStore.getState().close();
  });

  it("starts with no trip time and no constraints", () => {
    const state = useDirectionsStore.getState();
    expect(state.timeMode).toBe("now");
    expect(state.tripTime).toBeNull();
    expect(state.hasScheduleConstraints()).toBe(false);
  });

  it("sets and clears a waypoint schedule", () => {
    useDirectionsStore.getState().setWaypointSchedule(0, { dwellSeconds: 600 });
    expect(useDirectionsStore.getState().waypoints[0].schedule).toEqual({ dwellSeconds: 600 });
    useDirectionsStore.getState().setWaypointSchedule(0, null);
    expect(useDirectionsStore.getState().waypoints[0].schedule).toBeUndefined();
  });

  it("ignores an out-of-range waypoint index", () => {
    const before = useDirectionsStore.getState().waypoints;
    useDirectionsStore.getState().setWaypointSchedule(9, { dwellSeconds: 60 });
    expect(useDirectionsStore.getState().waypoints).toBe(before);
  });

  it("counts only window fields as constraints, not dwell", () => {
    useDirectionsStore.getState().setWaypointSchedule(0, { dwellSeconds: 600 });
    expect(useDirectionsStore.getState().hasScheduleConstraints()).toBe(false);
    useDirectionsStore.getState().setWaypointSchedule(0, { arriveBy: "2026-09-01T14:00" });
    expect(useDirectionsStore.getState().hasScheduleConstraints()).toBe(true);
  });

  it("moves whole waypoints when applying an optimized order", () => {
    const store = useDirectionsStore.getState();
    store.addWaypoint(0);
    useDirectionsStore.getState().setWaypoint(0, [0, 0], "A");
    useDirectionsStore.getState().setWaypoint(1, [1, 1], "B");
    useDirectionsStore.getState().setWaypoint(2, [2, 2], "C");
    useDirectionsStore.getState().setWaypointSchedule(1, { dwellSeconds: 900 });

    expect(useDirectionsStore.getState().applyWaypointOrder([0, 2, 1])).toBe(true);
    const after = useDirectionsStore.getState().waypoints;
    expect(after.map((wp) => wp.label)).toEqual(["A", "C", "B"]);
    expect(after[2].schedule).toEqual({ dwellSeconds: 900 });
    expect(after.map((wp) => wp.type)).toEqual(["origin", "waypoint", "destination"]);
  });

  it("refuses to reorder while a window constraint is set", () => {
    useDirectionsStore.getState().addWaypoint(0);
    useDirectionsStore.getState().setWaypoint(0, [0, 0], "A");
    useDirectionsStore.getState().setWaypoint(1, [1, 1], "B");
    useDirectionsStore.getState().setWaypoint(2, [2, 2], "C");
    useDirectionsStore.getState().setWaypointSchedule(1, { fixedAt: "2026-09-01T14:00" });

    expect(useDirectionsStore.getState().applyWaypointOrder([0, 2, 1])).toBe(false);
    expect(useDirectionsStore.getState().waypoints.map((wp) => wp.label)).toEqual(["A", "B", "C"]);
  });

  it("clears the trip time and every schedule on close", () => {
    useDirectionsStore.getState().setTimeMode("depart");
    useDirectionsStore.getState().setTripTime(new Date("2026-09-01T09:00:00Z"));
    useDirectionsStore.getState().setWaypointSchedule(0, { dwellSeconds: 600 });
    useDirectionsStore.getState().close();
    const after = useDirectionsStore.getState();
    expect(after.timeMode).toBe("now");
    expect(after.tripTime).toBeNull();
    expect(after.waypoints.every((wp) => wp.schedule === undefined)).toBe(true);
  });

  it("drops the time value when switching back to now", () => {
    useDirectionsStore.getState().setTimeMode("arrive");
    useDirectionsStore.getState().setTripTime(new Date("2026-09-01T09:00:00Z"));
    useDirectionsStore.getState().setTimeMode("now");
    expect(useDirectionsStore.getState().tripTime).toBeNull();
  });
});
