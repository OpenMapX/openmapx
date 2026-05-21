import { describe, expect, it } from "vitest";
import { findNearestStation, type TideStation } from "../data.js";

const STATIONS: TideStation[] = [
  { id: "9414290", name: "San Francisco", lat: 37.8067, lng: -122.4659 },
  { id: "9410230", name: "La Jolla", lat: 32.866, lng: -117.2573 },
  { id: "9447130", name: "Seattle", lat: 47.6026, lng: -122.3393 },
  { id: "8518750", name: "The Battery, NY", lat: 40.7006, lng: -74.0142 },
];

describe("findNearestStation", () => {
  it("finds San Francisco when querying near the Bay", () => {
    const nearest = findNearestStation(STATIONS, 37.7749, -122.4194, 50);
    expect(nearest?.station.id).toBe("9414290");
    expect(nearest?.distanceKm).toBeLessThan(10);
  });

  it("finds The Battery when querying near Manhattan", () => {
    const nearest = findNearestStation(STATIONS, 40.7128, -74.006, 50);
    expect(nearest?.station.id).toBe("8518750");
  });

  it("returns null when nothing is within range (inland user)", () => {
    // Denver, CO — far from any tide station
    const nearest = findNearestStation(STATIONS, 39.7392, -104.9903, 50);
    expect(nearest).toBeNull();
  });

  it("respects maxKm — a tight radius rejects a moderately-close station", () => {
    const nearest = findNearestStation(STATIONS, 37.7749, -122.4194, 1);
    expect(nearest).toBeNull();
  });

  it("picks the closer station when two are in range", () => {
    // A point closer to La Jolla than San Francisco but within both ranges:
    const nearest = findNearestStation(STATIONS, 33.0, -117.5, 1000);
    expect(nearest?.station.id).toBe("9410230");
  });
});
