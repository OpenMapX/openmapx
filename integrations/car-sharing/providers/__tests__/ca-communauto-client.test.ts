import { describe, expect, it } from "vitest";
import { mapCommunautoStation, parseCommunautoStations } from "../ca-communauto-client.js";

describe("mapCommunautoStation", () => {
  it("maps an available station (recommended vehicle) to 1 available car", () => {
    const station = mapCommunautoStation(59, {
      stationId: 906,
      stationName: "Mercier et Birch",
      stationNb: "425",
      stationLocation: { latitude: 45.501183, longitude: -73.504447 },
      recommendedVehicleId: 6165,
      satisfiesFilters: true,
    });

    expect(station).toEqual({
      id: "ca-communauto/59/906",
      name: "Mercier et Birch",
      coordinates: [-73.504447, 45.501183],
      availableVehicles: 1,
      operator: "Communauto",
      vehicleTypes: ["car"],
      stationType: "fixed",
      isActive: true,
      isRenting: true,
      website: "https://www.communauto.com",
      sources: ["ca-communauto"],
    });
  });

  it("treats a station with no recommended vehicle as 0 available", () => {
    const station = mapCommunautoStation(105, {
      stationId: 42,
      stationName: "King & Bay",
      stationLocation: { latitude: 43.6, longitude: -79.4 },
      recommendedVehicleId: null,
      satisfiesFilters: false,
    });

    expect(station?.availableVehicles).toBe(0);
    expect(station?.isRenting).toBe(false);
    expect(station?.isActive).toBe(true); // the station still exists on the map
  });

  it("falls back to the station number when the name is missing", () => {
    const station = mapCommunautoStation(59, {
      stationId: 1,
      stationNb: "425",
      stationLocation: { latitude: 45.5, longitude: -73.5 },
    });
    expect(station?.name).toBe("Station 425");
  });

  it("returns null when the station has no location", () => {
    expect(mapCommunautoStation(59, { stationId: 1 })).toBeNull();
  });
});

describe("parseCommunautoStations", () => {
  it("maps the stations array and drops coordinate-less entries", () => {
    const stations = parseCommunautoStations(90, {
      stations: [
        {
          stationId: 1,
          stationName: "A",
          stationLocation: { latitude: 46.8, longitude: -71.2 },
          recommendedVehicleId: 5,
        },
        { stationId: 2, stationName: "B" }, // no location → dropped
      ],
    });

    expect(stations).toHaveLength(1);
    expect(stations[0].id).toBe("ca-communauto/90/1");
  });

  it("handles an empty or absent stations array", () => {
    expect(parseCommunautoStations(59, {})).toEqual([]);
    expect(parseCommunautoStations(59, { stations: [] })).toEqual([]);
  });
});
