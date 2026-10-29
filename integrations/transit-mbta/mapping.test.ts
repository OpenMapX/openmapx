import { describe, expect, it } from "vitest";
import { Predictions, StopResource, VehicleResource } from "./generated/models";
import { angularRadius, mapDepartures, mapStop, mapVehicle } from "./mapping";

const stop = {
  type: "stop",
  id: "70067",
  attributes: { name: "Harvard", latitude: 42.36, longitude: -71.06, vehicle_type: 1 },
};
const prediction = {
  type: "prediction",
  id: "p",
  attributes: {
    departure_time: "2026-10-22T12:05:00Z",
    arrival_time: null,
    trip_headsign: "Alewife",
  },
  relationships: {
    route: { data: { id: "Red", type: "route" } },
    trip: { data: { id: "t", type: "trip" } },
    stop: { data: { id: "70067", type: "stop" } },
    schedule: { data: { id: "s", type: "schedule" } },
  },
};
function page() {
  return {
    data: [structuredClone(prediction)],
    included: [
      {
        type: "route",
        id: "Red",
        attributes: { short_name: "Red", long_name: "Red Line", type: 1, color: "DA291C" },
      },
      {
        type: "schedule",
        id: "s",
        attributes: { departure_time: "2026-10-22T12:03:00Z", arrival_time: null },
      },
      { type: "trip", id: "t", attributes: { headsign: "Ashmont" } },
      { type: "stop", id: "70067", attributes: { platform_code: "A" } },
    ],
  };
}
describe("MBTA canonical mapping", () => {
  it("uses an angular query bound and maps valid stop coordinates", () => {
    expect(angularRadius(42.36, 1000)).toBeLessThan(0.02);
    expect(angularRadius(42.36, 1000)).toBeGreaterThan(0.012);
    expect(mapStop(StopResource.parse(stop))).toMatchObject({
      id: "mb:70067",
      lat: 42.36,
      lng: -71.06,
    });
  });
  it("does not invent stop or vehicle coordinates or observation time", () => {
    expect(mapStop(StopResource.parse({ type: "stop", id: "s" }))).toBeNull();
    expect(
      mapStop(StopResource.parse({ ...stop, attributes: { ...stop.attributes, latitude: 91 } })),
    ).toBeNull();
    expect(
      mapVehicle(
        VehicleResource.parse({
          type: "vehicle",
          id: "v",
          attributes: { latitude: 42.36, longitude: -71.06 },
        }),
        "Red",
      ),
    ).toBeNull();
  });
  it("uses documented destination/platform fields, preserves delay and prefixes matching trip IDs", () => {
    expect(
      mapDepartures(Predictions.parse(page()), 30, Date.parse("2026-10-22T12:00:00Z"))[0],
    ).toMatchObject({
      tripId: "mb:t",
      headsign: "Alewife",
      platform: "A",
      scheduledAt: "2026-10-22T12:03:00Z",
      expectedAt: "2026-10-22T12:05:00Z",
      delaySeconds: 120,
    });
  });
  it("falls back to the trip headsign when no override exists", () => {
    const p = page();
    p.data[0].attributes.trip_headsign = "";
    expect(
      mapDepartures(Predictions.parse(p), 30, Date.parse("2026-10-22T12:00:00Z"))[0].headsign,
    ).toBe("Ashmont");
  });
  it("keeps an added trip without schedule linkage and does not invent its delay", () => {
    const p = page();
    Object.assign(p.data[0].relationships.schedule, { data: null });
    const d = mapDepartures(Predictions.parse(p), 30, Date.parse("2026-10-22T12:00:00Z"))[0];
    expect(d.expectedAt).toBe("2026-10-22T12:05:00Z");
    expect(d.delaySeconds).toBeUndefined();
  });
  it("bounds the departure time window and sorts by expected time", () => {
    const p = page();
    p.data.push({
      ...structuredClone(prediction),
      id: "old",
      attributes: { ...prediction.attributes, departure_time: "2026-10-22T11:59:00Z" },
    });
    expect(
      mapDepartures(Predictions.parse(p), 30, Date.parse("2026-10-22T12:00:00Z")),
    ).toHaveLength(1);
    expect(mapDepartures(Predictions.parse(p), 1, Date.parse("2026-10-22T12:00:00Z"))).toHaveLength(
      0,
    );
  });
  it("retains feed timestamps and actual primary vehicle route instead of replacing it with the route filter", () => {
    expect(
      mapVehicle(
        VehicleResource.parse({
          type: "vehicle",
          id: "v",
          attributes: {
            latitude: 42.36,
            longitude: -71.06,
            updated_at: "2026-10-22T11:59:00Z",
            speed: 0,
            bearing: 0,
          },
          relationships: {
            route: { data: { type: "route", id: "Green" } },
            trip: { data: { type: "trip", id: "t" } },
          },
        }),
        "Red",
      ),
    ).toMatchObject({
      tripId: "mb:t",
      routeId: "mb:Green",
      updatedAt: "2026-10-22T11:59:00Z",
      speed: 0,
      bearing: 0,
    });
  });
});

it("keeps cancelled service with null realtime times when its included schedule is known", () => {
  const p = page();
  Object.assign(p.data[0].attributes, { departure_time: null, schedule_relationship: "CANCELLED" });
  expect(
    mapDepartures(Predictions.parse(p), 30, Date.parse("2026-10-22T12:00:00Z"))[0],
  ).toMatchObject({
    scheduledAt: "2026-10-22T12:03:00Z",
    canceled: true,
    expectedAt: undefined,
    delaySeconds: undefined,
  });
});
