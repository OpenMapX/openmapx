import type { TripItinerary } from "@openmapx/mobility-core/transit";
import { expect, it } from "vitest";
import type { Route } from "../types/routing";
import { walkStepInfo } from "./transitWalk";
import { repairTransitWalk } from "./transitWalkRepair";

const walk = {
  mode: "walking",
  from: { name: "Home", lat: 0, lng: 0 },
  to: { name: "Board", lat: 0, lng: 0.002 },
  geometry: {
    type: "LineString",
    coordinates: [
      [0, 0],
      [0.002, 0],
    ],
  },
};
const trip = {
  legs: [
    walk,
    {
      mode: "bus",
      tripId: "selected",
      from: walk.to,
      to: { name: "Destination", lng: 0.02, lat: 0 },
    },
  ],
} as TripItinerary;
const route = {
  mode: "walking",
  distance: 200,
  duration: 150,
  geometry: [
    [0.001, 0.001],
    [0.002, 0],
  ],
  steps: [
    {
      instruction: "Turn left onto Main Street",
      maneuver: { type: "turn", modifier: "left" },
      distance: 200,
      duration: 150,
      coordinates: [
        [0.001, 0.001],
        [0.002, 0],
      ],
    },
  ],
} as Route;
it("repairs only the walking path while preserving the selected service and target", () => {
  const next = repairTransitWalk(trip, 0, route);
  expect(next?.legs[1]).toBe(trip.legs[1]);
  expect(next?.legs[0].to).toBe(trip.legs[0].to);
  expect(next?.legs[0].geometry.coordinates).toEqual(route.geometry);
  const repairedStep = next?.legs[0].steps?.[0];
  if (!repairedStep) throw Error("Expected repaired walking step");
  expect(walkStepInfo(repairedStep).maneuver).toEqual({
    type: "turn",
    modifier: "left",
  });
  expect(next?.legs[0].steps?.[0].instructionText).toBe("Turn left onto Main Street");
});
it("rejects a walking route ending at a different stop or a nonwalking update", () => {
  expect(
    repairTransitWalk(trip, 0, {
      ...route,
      geometry: [
        [0, 0],
        [1, 1],
      ],
    }),
  ).toBeNull();
  expect(repairTransitWalk(trip, 1, route)).toBeNull();
  expect(repairTransitWalk(trip, 0, { ...route, mode: "driving" })).toBeNull();
});
