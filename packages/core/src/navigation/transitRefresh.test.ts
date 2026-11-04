import type { TripItinerary } from "@openmapx/mobility-core/transit";
import { expect, it } from "vitest";
import { mergeTransitRefresh } from "./transitRefresh";

const current = {
  legs: [
    {
      mode: "walking",
      from: { name: "Home", lng: 0, lat: 0 },
      to: { name: "Stop", stopId: "a", lng: 0.002, lat: 0 },
      geometry: {
        type: "LineString",
        coordinates: [
          [0.001, 0.001],
          [0.002, 0],
        ],
      },
      steps: [{ instruction: "LEFT", distanceMeters: 200 }],
    },
    { mode: "bus", tripId: "selected", from: { stopId: "a" }, to: { stopId: "b" } },
  ],
} as TripItinerary;
it("keeps a repaired active walking path during live timetable refresh", () => {
  const next = structuredClone(current);
  next.legs[0].geometry.coordinates = [
    [0, 0],
    [0.002, 0],
  ];
  const merged = mergeTransitRefresh(current, next, 0, 1);
  expect(merged?.itinerary.legs[0].geometry).toBe(current.legs[0].geometry);
  expect(merged?.resetWalk).toBe(false);
});
it("resets the walk gate when a refreshed platform changes the walking target", () => {
  const next = structuredClone(current);
  next.legs[0].to.lng = 0.003;
  const merged = mergeTransitRefresh(current, next, 0, 1);
  expect(merged?.resetWalk).toBe(true);
  expect(merged?.itinerary.legs[0].to.lng).toBe(0.003);
});
it("does not accept a different selected vehicle", () => {
  const next = structuredClone(current);
  next.legs[1].tripId = "other";
  expect(mergeTransitRefresh(current, next, 0, 0)).toBeNull();
});
