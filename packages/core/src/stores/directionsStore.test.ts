import { beforeEach, describe, expect, it } from "vitest";
import { transitPlanQueryKey } from "../api/transit";
import { providerPlanSelection } from "../travel-plans/__fixtures__/providerPlan";
import { MAX_DIRECTIONS_WAYPOINTS, useDirectionsStore } from "./directionsStore";

function reset() {
  // close() restores the initial transit-options state.
  useDirectionsStore.getState().close();
}

describe("directionsStore transit options", () => {
  beforeEach(reset);

  it("toggleTransitPreferredMode adds then removes a mode and resets the selected itinerary", () => {
    useDirectionsStore.setState({ activeItineraryIndex: 2 });
    useDirectionsStore.getState().toggleTransitPreferredMode("bus");
    expect(useDirectionsStore.getState().transitPreferredModes).toEqual(["bus"]);
    expect(useDirectionsStore.getState().activeItineraryIndex).toBe(0);
    useDirectionsStore.getState().toggleTransitPreferredMode("subway");
    expect(useDirectionsStore.getState().transitPreferredModes).toEqual(["bus", "subway"]);
    useDirectionsStore.getState().toggleTransitPreferredMode("bus");
    expect(useDirectionsStore.getState().transitPreferredModes).toEqual(["subway"]);
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

  it("close() resets transit options back to defaults", () => {
    expect(useDirectionsStore.getState().deutschlandticketOnly).toBe(false);
    useDirectionsStore.getState().toggleTransitPreferredMode("train");
    useDirectionsStore.getState().setTransitRoutePreference("lessWalking");
    useDirectionsStore.getState().setDeutschlandticketOnly(true);
    expect(useDirectionsStore.getState().deutschlandticketOnly).toBe(true);
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

  it("sets and clears a waypoint schedule", () => {
    const state = useDirectionsStore.getState();
    expect(state.timeMode).toBe("now");
    expect(state.tripTime).toBeNull();
    expect(state.hasScheduleConstraints()).toBe(false);
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

describe("normal provider trip selection handoff", () => {
  beforeEach(reset);
  const selection = () =>
    providerPlanSelection({ bikeHillPreference: useDirectionsStore.getState().bikeHillPreference });
  it("publishes provider endpoints and the normal trip without DB metadata", () => {
    const result = selection();
    expect(useDirectionsStore.getState().openTransitSelection(result)).toBe(true);
    const s = useDirectionsStore.getState();
    expect(s.mode).toBe("transit");
    expect(s.transitTimeMode).toBe("depart");
    expect(s.waypoints.map((w) => w.label)).toEqual(["Provider Aachen", "Provider Koeln"]);
    expect(s.transitDepartureTime).toEqual(new Date("2026-11-06T20:16:00.000Z"));
    expect(s.transitItineraries[0]).toBe(result.plan.data.itineraries[0]);
    expect(s.pendingTransitSelection).toEqual({
      requestKey: JSON.stringify(transitPlanQueryKey(result.query)),
      itineraryKey: result.selectedItineraryKey,
    });
    expect("importedTransitTrip" in s).toBe(false);
  });
  it("fences old publications only until the matching normal result is consumed", () => {
    const result = selection();
    useDirectionsStore.getState().openTransitSelection(result);
    const pending = useDirectionsStore.getState().pendingTransitSelection;
    if (!pending) throw new Error("missing handoff");
    useDirectionsStore.getState().setTransitItineraries([], "old-query");
    expect(useDirectionsStore.getState().transitItineraries).toHaveLength(1);
    expect(useDirectionsStore.getState().completeTransitSelection(pending)).toBe(true);
    useDirectionsStore.getState().setTransitItineraries([]);
    expect(useDirectionsStore.getState().transitItineraries).toHaveLength(0);
    expect(useDirectionsStore.getState().pendingTransitSelection).toBeNull();
  });
  it("does not consume a newer handoff with an old callback", () => {
    const result = selection();
    useDirectionsStore.getState().openTransitSelection(result);
    const old = useDirectionsStore.getState().pendingTransitSelection;
    if (!old) throw new Error("missing handoff");
    useDirectionsStore.getState().openTransitSelection(result);
    expect(useDirectionsStore.getState().completeTransitSelection(old)).toBe(false);
    expect(useDirectionsStore.getState().pendingTransitSelection).not.toBeNull();
  });
  it.each(["waypoint", "mode", "time", "options", "close"])(
    "releases the provider reference on %s",
    (action) => {
      const result = selection();
      const leg = result.plan.data.itineraries[0].legs[0];
      result.query = {
        kind: "reference",
        params: {
          reference: {
            datasetEpoch: "E",
            legs: [
              {
                tripId: "ms:10935",
                fromStopId: "ms:a",
                toStopId: "ms:b",
                scheduledDeparture: leg.scheduledStartTime ?? "",
                scheduledArrival: leg.scheduledEndTime ?? "",
              },
            ],
          },
          bikeHillPreference: useDirectionsStore.getState().bikeHillPreference,
        },
      };
      useDirectionsStore.getState().openTransitSelection(result);
      expect(useDirectionsStore.getState().transitReference).not.toBeNull();
      const s = useDirectionsStore.getState();
      if (action === "waypoint") s.setWaypoint(0, [8, 52], "Edited");
      if (action === "mode") s.setMode("walking");
      if (action === "time") s.setTransitTimeMode("arrive");
      if (action === "options") s.setMaxTransfers(2);
      if (action === "close") s.close();
      expect(useDirectionsStore.getState().transitReference).toBeNull();
      expect(useDirectionsStore.getState().pendingTransitSelection).toBeNull();
    },
  );
  it("does not weaken an accessibility requirement that changed while resolving", () => {
    const result = selection();
    useDirectionsStore.getState().setWheelchairRequired(true);
    expect(useDirectionsStore.getState().openTransitSelection(result)).toBe(false);
    expect(useDirectionsStore.getState().isOpen).toBe(false);
  });
  it("retains bike access and its visible carriage requirement instead of hiding it in a walk query", () => {
    const s = useDirectionsStore.getState();
    s.setTransitAccessMode("bike");
    s.setRequireBikeTransport(true);
    const result = providerPlanSelection({
      requireBikeTransport: true,
      bikeHillPreference: s.bikeHillPreference,
    });
    expect(useDirectionsStore.getState().openTransitSelection(result)).toBe(false);
    expect(useDirectionsStore.getState()).toMatchObject({
      transitAccessMode: "bike",
      requireBikeTransport: true,
      isOpen: false,
    });
  });
});
