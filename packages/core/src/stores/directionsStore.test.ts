import { beforeEach, describe, expect, it } from "vitest";
import { MAX_DIRECTIONS_WAYPOINTS, useDirectionsStore } from "./directionsStore";

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

describe("insertWaypoint", () => {
  beforeEach(() => {
    reset();
    const s = useDirectionsStore.getState();
    s.setWaypoint(0, [0, 0], "Home");
    s.setWaypoint(1, [1, 0], "Work");
    useDirectionsStore.setState({ activeRouteIndex: 1 });
  });

  it("inserts a filled stop between origin and destination", () => {
    expect(useDirectionsStore.getState().insertWaypoint(1, [0.5, 0], "Aral")).toBe(true);
    const { waypoints, activeRouteIndex } = useDirectionsStore.getState();
    expect(waypoints.map((wp) => [wp.type, wp.label, wp.coords])).toEqual([
      ["origin", "Home", [0, 0]],
      ["waypoint", "Aral", [0.5, 0]],
      ["destination", "Work", [1, 0]],
    ]);
    expect(new Set(waypoints.map((wp) => wp.id)).size).toBe(3);
    expect(activeRouteIndex).toBe(0);
  });

  it("refuses to replace the origin or append after the destination", () => {
    const before = useDirectionsStore.getState().waypoints;
    expect(useDirectionsStore.getState().insertWaypoint(0, [0.5, 0], "Aral")).toBe(false);
    expect(useDirectionsStore.getState().insertWaypoint(2, [0.5, 0], "Aral")).toBe(false);
    expect(useDirectionsStore.getState().waypoints).toBe(before);
  });

  it("refuses a stop once the route has the most waypoints it can take", () => {
    const s = useDirectionsStore.getState();
    for (let i = 0; i < MAX_DIRECTIONS_WAYPOINTS - 2; i++) {
      expect(s.insertWaypoint(1, [0.1 * (i + 1), 0], `Stop ${i}`)).toBe(true);
    }
    expect(MAX_DIRECTIONS_WAYPOINTS).toBe(10);
    const full = useDirectionsStore.getState().waypoints;
    expect(full).toHaveLength(10);
    expect(useDirectionsStore.getState().insertWaypoint(1, [0.95, 0], "One more")).toBe(false);
    expect(useDirectionsStore.getState().waypoints).toBe(full);
  });
});

describe("fixed imported transit connections", () => {
  beforeEach(reset);
  const plan = {
    sourceId: "test",
    sourceLabel: "Test",
    origin: "A",
    destination: "B",
    timeZone: "Europe/Berlin",
    legs: [],
  };
  const itinerary = {
    startTime: "2026-11-06T20:18:00Z",
    endTime: "2026-11-06T21:11:00Z",
    duration: 3180,
    transfers: 0,
    walkDistance: 0,
    legs: [
      {
        mode: "rail" as const,
        startTime: "2026-11-06T20:18:00Z",
        endTime: "2026-11-06T21:11:00Z",
        scheduledStartTime: "2026-11-06T20:18:00Z",
        from: { name: "A", lat: 50, lng: 6 },
        to: { name: "B", lat: 51, lng: 7 },
        geometry: {
          type: "LineString" as const,
          coordinates: [
            [6, 50],
            [7, 51],
          ] as [number, number][],
        },
      },
    ],
  };
  it("opens endpoints and exact trip atomically and ignores stale planning publication", () => {
    useDirectionsStore.getState().openImportedTransitTrip(plan, { itinerary, schematic: true });
    const s = useDirectionsStore.getState();
    expect(s.mode).toBe("transit");
    expect(s.isOpen).toBe(true);
    expect(s.waypoints.map((w) => w.label)).toEqual(["A", "B"]);
    expect(s.transitDepartureTime).toEqual(new Date(itinerary.startTime));
    s.setTransitItineraries([]);
    expect(useDirectionsStore.getState().transitItineraries).toEqual([itinerary]);
  });
  it.each(["waypoint", "mode", "time", "options", "close", "alternatives"])(
    "releases the fixed trip on %s",
    (action) => {
      useDirectionsStore.getState().openImportedTransitTrip(plan, { itinerary, schematic: false });
      const s = useDirectionsStore.getState();
      if (action === "waypoint") s.setWaypoint(0, [8, 52], "Edited");
      if (action === "mode") s.setMode("walking");
      if (action === "time") s.setTransitDepartureTime("now");
      if (action === "options") s.setMaxTransfers(2);
      if (action === "close") s.close();
      if (action === "alternatives") s.clearImportedTransitTrip();
      expect(useDirectionsStore.getState().importedTransitTrip).toBeNull();
      s.setTransitItineraries([]);
      expect(useDirectionsStore.getState().transitItineraries).toEqual([]);
    },
  );
});
