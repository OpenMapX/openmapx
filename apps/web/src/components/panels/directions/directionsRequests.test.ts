import type { Waypoint } from "@openmapx/core";
import { describe, expect, it } from "vitest";
import {
  buildArrivalContext,
  buildGroundRequest,
  drivingWallClocks,
  placedCoordinates,
  tripComplete,
} from "./directionsRequests";

const stop = (id: string, coords: [number, number] | null): Waypoint => ({
  id,
  coords,
  label: id,
  type: "waypoint",
});
const BERLIN: [number, number] = [13.4, 52.52];
const LISBON: [number, number] = [-9.14, 38.72];

describe("placedCoordinates and tripComplete", () => {
  it("keeps placed stops in order and needs two placed stops", () => {
    const trip = [stop("a", BERLIN), stop("b", null), stop("c", LISBON)];
    expect(placedCoordinates(trip)).toEqual([BERLIN, LISBON]);
    expect(tripComplete(trip)).toBe(false);
    expect(tripComplete([stop("a", BERLIN), stop("c", LISBON)])).toBe(true);
    expect(tripComplete([stop("a", BERLIN)])).toBe(false);
  });
});

describe("drivingWallClocks", () => {
  const at = new Date(2026, 10, 20, 8, 5);

  it("states a departure or a deadline for timed ground modes", () => {
    expect(drivingWallClocks("driving", "depart", at)).toEqual({ departAt: "2026-11-20T08:05" });
    expect(drivingWallClocks("motorcycle", "arrive", at)).toEqual({
      arriveBy: "2026-11-20T08:05",
    });
  });

  it("states nothing for now, a missing time or an untimed mode", () => {
    expect(drivingWallClocks("driving", "now", at)).toEqual({});
    expect(drivingWallClocks("driving", "depart", null)).toEqual({});
    expect(drivingWallClocks("cycling", "depart", at)).toEqual({});
  });
});

describe("buildGroundRequest", () => {
  it("carries every option the displayed route was planned with", () => {
    expect(
      buildGroundRequest({
        mode: "cycling",
        avoidHighways: true,
        avoidTolls: false,
        avoidFerries: true,
        bikeProfile: "road",
        bikePreferQuietRoads: true,
        avoidClosures: true,
        units: "imperial",
        lang: "de",
        departAt: "2026-11-20T08:05",
      }),
    ).toEqual({
      mode: "cycling",
      avoidHighways: true,
      avoidTolls: false,
      avoidFerries: true,
      bikeProfile: "road",
      bikeHillPreference: undefined,
      bikePreferQuietRoads: true,
      bikePreferSmoothSurfaces: undefined,
      bikeSpeedKmh: undefined,
      avoidClosures: true,
      units: "imperial",
      lang: "de",
      departAt: "2026-11-20T08:05",
      arriveBy: undefined,
    });
  });
});

describe("buildArrivalContext", () => {
  const ends = { origin: BERLIN, destination: LISBON };

  it("reads arrivals from now in the destination's zone", () => {
    expect(buildArrivalContext({ mode: "driving", timeMode: "now", ...ends })).toEqual({
      kind: "now",
      destinationTimeZone: "Europe/Lisbon",
    });
  });

  it("reads a departure in the origin's zone and a deadline in the destination's", () => {
    expect(
      buildArrivalContext({
        mode: "driving",
        timeMode: "depart",
        departAt: "2026-11-20T08:05",
        ...ends,
      }),
    ).toEqual({
      kind: "departAt",
      wallClock: "2026-11-20T08:05",
      originTimeZone: "Europe/Berlin",
      destinationTimeZone: "Europe/Lisbon",
    });
    expect(
      buildArrivalContext({
        mode: "motorcycle",
        timeMode: "arrive",
        arriveBy: "2026-11-20T18:00",
        ...ends,
      }),
    ).toEqual({
      kind: "arriveBy",
      wallClock: "2026-11-20T18:00",
      destinationTimeZone: "Europe/Lisbon",
    });
  });

  it("states no arrival for untimed modes or a timed mode still waiting for its time", () => {
    expect(buildArrivalContext({ mode: "walking", timeMode: "now", ...ends })).toBeUndefined();
    expect(buildArrivalContext({ mode: "driving", timeMode: "depart", ...ends })).toBeUndefined();
  });
});
