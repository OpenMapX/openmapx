import type { TransitStopArea, TripItinerary } from "@openmapx/mobility-core/transit";
import { describe, expect, it } from "vitest";
import {
  convexHull,
  defaultStopAreaShape,
  isWithinStopArea,
  resolveTransitLegTargets,
  spanMeters,
  stopAreaDistance,
  stopAreaShapeDistance,
  stopAreaTolerance,
  transitStopAreaKey,
  transitStopsNeedingAreas,
} from "./transitStopAreas";

/** Metres east of a point at latitude 50.78, in degrees of longitude. */
const east = (lng: number, meters: number) =>
  lng + meters / (111_320 * Math.cos((50.78 * Math.PI) / 180));
/** Metres north, in degrees of latitude. */
const north = (lat: number, meters: number) => lat + meters / 110_574;

const LAT = 50.78;
const LNG = 6.09;

describe("stop area shapes", () => {
  it("measures a point shape from its buffer edge", () => {
    const shape = defaultStopAreaShape([LNG, LAT], "bus");
    expect(stopAreaShapeDistance(shape, [east(LNG, 10), LAT])).toBe(0);
    expect(stopAreaShapeDistance(shape, [east(LNG, 40), LAT])).toBeCloseTo(15, 0);
  });

  it("sizes the default circle for the vehicle", () => {
    expect(defaultStopAreaShape([LNG, LAT], "bus").bufferMeters).toBe(25);
    expect(defaultStopAreaShape([LNG, LAT], "rail").bufferMeters).toBe(50);
    expect(defaultStopAreaShape([LNG, LAT], "subway").bufferMeters).toBe(50);
  });

  it("measures a line shape along its whole length", () => {
    // A 300 m platform edge, buffered by half a platform's width.
    const shape = {
      type: "line" as const,
      coordinates: [
        [LNG, LAT],
        [east(LNG, 300), LAT],
      ] as [number, number][],
      bufferMeters: 4,
    };
    expect(stopAreaShapeDistance(shape, [east(LNG, 250), north(LAT, 3)])).toBe(0);
    expect(stopAreaShapeDistance(shape, [east(LNG, 150), north(LAT, 14)])).toBeCloseTo(10, 0);
    expect(stopAreaShapeDistance(shape, [east(LNG, 320), LAT])).toBeCloseTo(16, 0);
  });

  it("treats the inside of a polygon as distance zero", () => {
    const ring: [number, number][] = [
      [LNG, LAT],
      [east(LNG, 200), LAT],
      [east(LNG, 200), north(LAT, 10)],
      [LNG, north(LAT, 10)],
    ];
    const shape = { type: "polygon" as const, coordinates: ring, bufferMeters: 3 };
    expect(stopAreaShapeDistance(shape, [east(LNG, 100), north(LAT, 5)])).toBe(0);
    expect(stopAreaShapeDistance(shape, [east(LNG, 100), north(LAT, 12)])).toBe(0);
    expect(stopAreaShapeDistance(shape, [east(LNG, 100), north(LAT, 23)])).toBeCloseTo(10, 0);
  });

  it("takes the nearest of several shapes", () => {
    const shapes = [
      defaultStopAreaShape([LNG, LAT], "bus"),
      defaultStopAreaShape([east(LNG, 200), LAT], "bus"),
    ];
    expect(stopAreaDistance(shapes, [east(LNG, 190), LAT])).toBe(0);
    expect(stopAreaDistance([], [LNG, LAT])).toBe(Number.POSITIVE_INFINITY);
  });

  it("widens an area by the fix accuracy, but only so far", () => {
    expect(stopAreaTolerance(8)).toBe(8);
    expect(stopAreaTolerance(65)).toBe(20);
    expect(stopAreaTolerance(undefined)).toBe(0);
    const shapes = [defaultStopAreaShape([LNG, LAT], "bus")];
    const outside: [number, number] = [east(LNG, 35), LAT];
    expect(isWithinStopArea(shapes, outside, 3)).toBe(false);
    expect(isWithinStopArea(shapes, outside, 15)).toBe(true);
    expect(isWithinStopArea(shapes, [east(LNG, 60), LAT], 200)).toBe(false);
  });
});

describe("convexHull", () => {
  it("wraps scattered platforms and drops the inner ones", () => {
    const hull = convexHull([
      [LNG, LAT],
      [east(LNG, 100), LAT],
      [east(LNG, 100), north(LAT, 100)],
      [LNG, north(LAT, 100)],
      [east(LNG, 50), north(LAT, 50)],
    ]);
    expect(hull).toHaveLength(4);
    expect(hull).not.toContainEqual([east(LNG, 50), north(LAT, 50)]);
  });

  it("measures the widest span", () => {
    expect(
      spanMeters([
        [LNG, LAT],
        [east(LNG, 300), LAT],
      ]),
    ).toBeCloseTo(300, 0);
  });
});

const BOARD = { name: "Blücherplatz", lat: LAT, lng: LNG, stopId: "mo:de:05334:1:1:1" };
const ALIGHT = { name: "Bushof", lat: LAT, lng: east(LNG, 2000), stopId: "mo:de:05334:2:1:1" };

function trip(walkStart: [number, number]): TripItinerary {
  return {
    legs: [
      {
        mode: "walking",
        from: { name: "START", lat: walkStart[1], lng: walkStart[0] },
        to: BOARD,
        geometry: { type: "LineString", coordinates: [walkStart, [LNG, LAT]] },
      },
      {
        mode: "bus",
        tripId: "trip-52",
        from: BOARD,
        to: ALIGHT,
        geometry: {
          type: "LineString",
          coordinates: [
            [LNG, LAT],
            [ALIGHT.lng, ALIGHT.lat],
          ],
        },
      },
      {
        mode: "walking",
        from: ALIGHT,
        to: { name: "END", lat: north(ALIGHT.lat, 300), lng: ALIGHT.lng },
        geometry: {
          type: "LineString",
          coordinates: [
            [ALIGHT.lng, ALIGHT.lat],
            [ALIGHT.lng, north(ALIGHT.lat, 300)],
          ],
        },
      },
    ],
  } as unknown as TripItinerary;
}

function area(stopId: string, overrides: Partial<TransitStopArea>): TransitStopArea {
  return { stopId, platform: [], station: [], source: "osm", ...overrides };
}

const PLATFORM = {
  type: "line" as const,
  coordinates: [
    [LNG, LAT],
    [east(LNG, 30), LAT],
  ] as [number, number][],
  bufferMeters: 4,
};
const STATION = {
  type: "polygon" as const,
  coordinates: [
    [east(LNG, -200), north(LAT, -200)],
    [east(LNG, 200), north(LAT, -200)],
    [east(LNG, 200), north(LAT, 200)],
    [east(LNG, -200), north(LAT, 200)],
  ] as [number, number][],
  bufferMeters: 10,
};

describe("resolveTransitLegTargets", () => {
  it("shares the boarding area between the walk that reaches it and the ride", () => {
    const targets = resolveTransitLegTargets(trip([east(LNG, -500), LAT]), {
      [`${BOARD.stopId}|`]: area(BOARD.stopId, { platform: [PLATFORM], station: [STATION] }),
    });
    expect(targets[0].end).toContain(PLATFORM);
    expect(targets[1].board).toBe(targets[0].end);
  });

  it("falls back from platform to station to a default circle", () => {
    const stationOnly = resolveTransitLegTargets(trip([east(LNG, -500), LAT]), {
      [`${BOARD.stopId}|`]: area(BOARD.stopId, { station: [STATION] }),
    });
    expect(stationOnly[0].end).toContain(STATION);
    const nothing = resolveTransitLegTargets(trip([east(LNG, -500), LAT]));
    expect(nothing[0].end).toEqual([defaultStopAreaShape([LNG, LAT], "bus")]);
  });

  it("skips an area the walk already starts in, as within one station", () => {
    // The transfer walk begins on another platform of the same station.
    const targets = resolveTransitLegTargets(trip([east(LNG, 120), north(LAT, 60)]), {
      [`${BOARD.stopId}|`]: area(BOARD.stopId, { station: [STATION] }),
    });
    expect(targets[0].end).toEqual([defaultStopAreaShape([LNG, LAT], "bus")]);
  });

  it("ends a ride at its alight stop and the trip at a small destination circle", () => {
    const targets = resolveTransitLegTargets(trip([east(LNG, -500), LAT]));
    expect(targets[1].end).toEqual([defaultStopAreaShape([ALIGHT.lng, ALIGHT.lat], "bus")]);
    expect(targets[2].end).toEqual([
      { type: "point", coordinates: [ALIGHT.lng, north(ALIGHT.lat, 300)], bufferMeters: 20 },
    ]);
  });
});

describe("transitStopsNeedingAreas", () => {
  it("lists every boarding and alighting stop once, with its vehicle mode", () => {
    expect(transitStopsNeedingAreas(trip([east(LNG, -500), LAT]))).toEqual([
      {
        key: `${BOARD.stopId}|`,
        stopId: BOARD.stopId,
        lat: LAT,
        lng: LNG,
        name: BOARD.name,
        mode: "bus",
      },
      {
        key: `${ALIGHT.stopId}|`,
        stopId: ALIGHT.stopId,
        lat: ALIGHT.lat,
        lng: ALIGHT.lng,
        name: ALIGHT.name,
        mode: "bus",
      },
    ]);
  });
});

describe("transitStopAreaKey", () => {
  it("separates the platforms a station-level id shares", () => {
    const arriving = { stopId: "db:8000001", platformCode: "2" };
    const leaving = { stopId: "db:8000001", platformCode: "7" };
    expect(transitStopAreaKey(arriving)).not.toBe(transitStopAreaKey(leaving));
    expect(transitStopAreaKey({ platformCode: "2" })).toBeNull();
  });

  it("asks for each platform of a transfer station once", () => {
    const station = { name: "Hbf", lat: LAT, lng: LNG, stopId: "db:8000001" };
    const transfer = {
      legs: [
        { mode: "rail", tripId: "a", from: { ...ALIGHT }, to: { ...station, platformCode: "2" } },
        { mode: "rail", tripId: "b", from: { ...station, platformCode: "7" }, to: { ...BOARD } },
      ],
    } as unknown as TripItinerary;
    expect(transitStopsNeedingAreas(transfer).map((stop) => stop.key)).toEqual([
      `${ALIGHT.stopId}|`,
      "db:8000001|2",
      "db:8000001|7",
      `${BOARD.stopId}|`,
    ]);
  });
});
