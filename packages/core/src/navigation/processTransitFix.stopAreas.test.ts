import type { TransitStopArea, TripItinerary } from "@openmapx/mobility-core/transit";
import { describe, expect, it } from "vitest";
import type { TransitLegCapture } from "./mobileProtocol";
import {
  DEFAULT_TRANSIT_TICK_OPTIONS,
  freshTransitTickState,
  processTransitFix,
  type TransitTickInput,
  type TransitTickState,
  transitProgressFromTick,
} from "./processTransitFix";
import { prepareTransitProgress } from "./transitProgress";
import type { TransitStopAreaIndex } from "./transitStopAreas";

/**
 * Stop areas against the stateful engine, on a station laid out in metres:
 * x runs east along a 400 m platform, y runs north. The rider walks onto the
 * platform at its west end, rides 1.5 km east to a second 400 m platform, and
 * walks 500 m north to the destination.
 */

const NOW = 1_700_000_000_000;
const LAT = 50.78;
const LNG = 6.09;
const M_LNG = 1 / (111_320 * Math.cos((LAT * Math.PI) / 180));
const M_LAT = 1 / 110_574;
const xy = (x: number, y: number): [number, number] => [LNG + x * M_LNG, LAT + y * M_LAT];

const BOARD_QUAY = {
  name: "Hbf",
  stopId: "mo:de:1:100:1:1",
  platformCode: "1",
  lat: LAT,
  lng: LNG,
};
const ALIGHT_QUAY = {
  name: "Ost",
  stopId: "mo:de:1:200:1:1",
  platformCode: "3",
  lat: xy(1500, 0)[1],
  lng: xy(1500, 0)[0],
};

const minutes = (n: number) => new Date(NOW + n * 60_000).toISOString();

function trip(): TripItinerary {
  return {
    legs: [
      {
        mode: "walking",
        from: { name: "START", lat: xy(-150, -300)[1], lng: xy(-150, -300)[0] },
        to: BOARD_QUAY,
        startTime: minutes(0),
        endTime: minutes(20),
        geometry: { type: "LineString", coordinates: [xy(-150, -300), xy(-150, -20), xy(0, 0)] },
        steps: [{ distanceMeters: 280 }, { distanceMeters: 151 }],
      },
      {
        mode: "rail",
        tripId: "re-1",
        from: BOARD_QUAY,
        to: ALIGHT_QUAY,
        startTime: minutes(22),
        endTime: minutes(26),
        geometry: { type: "LineString", coordinates: [xy(0, 0), xy(750, 0), xy(1500, 0)] },
      },
      {
        mode: "walking",
        from: ALIGHT_QUAY,
        to: { name: "END", lat: xy(1500, 500)[1], lng: xy(1500, 500)[0] },
        startTime: minutes(27),
        endTime: minutes(33),
        geometry: { type: "LineString", coordinates: [xy(1500, 0), xy(1500, 500)] },
        steps: [{ distanceMeters: 500 }],
      },
    ],
  } as unknown as TripItinerary;
}

function platform(fromX: number, toX: number) {
  return {
    type: "polygon" as const,
    coordinates: [xy(fromX, -5), xy(toX, -5), xy(toX, 5), xy(fromX, 5)],
    bufferMeters: 3,
  };
}

const AREAS: TransitStopAreaIndex = {
  [`${BOARD_QUAY.stopId}|${BOARD_QUAY.platformCode}`]: {
    stopId: BOARD_QUAY.stopId,
    platform: [platform(-200, 200)],
    station: [],
    source: "osm",
  } satisfies TransitStopArea,
  [`${ALIGHT_QUAY.stopId}|${ALIGHT_QUAY.platformCode}`]: {
    stopId: ALIGHT_QUAY.stopId,
    platform: [platform(1300, 1700)],
    station: [],
    source: "osm",
  } satisfies TransitStopArea,
};

const CAPTURES: TransitLegCapture[] = [
  {
    legIndex: 1,
    tripId: "re-1",
    capturedAtMs: NOW,
    status: "captured",
    stops: [
      { stopId: BOARD_QUAY.stopId, name: "Hbf", lat: LAT, lng: LNG },
      { stopId: "mid", name: "Mitte", lat: xy(750, 0)[1], lng: xy(750, 0)[0] },
      { stopId: ALIGHT_QUAY.stopId, name: "Ost", lat: ALIGHT_QUAY.lat, lng: ALIGHT_QUAY.lng },
    ],
  },
];

function tick(
  state: TransitTickState,
  at: [number, number],
  nowMs: number,
  overrides: Partial<TransitTickInput> = {},
) {
  return processTransitFix({
    itinerary: trip(),
    captures: CAPTURES,
    state,
    fix: { coords: at, accuracy: 5, timestampMs: nowMs },
    nowMs,
    options: { ...DEFAULT_TRANSIT_TICK_OPTIONS, itineraryFingerprint: "fp" },
    stopAreas: AREAS,
    ...overrides,
  });
}

describe("processTransitFix with stop areas", () => {
  it("reaches the stop on stepping onto the platform, far from its point and early", () => {
    // West end of the platform: 150 m from the quay point, 20 min before the walk's end.
    const result = tick(freshTransitTickState(NOW), xy(-150, -4), NOW + 60_000);
    expect(result.state.currentLegIndex).toBe(1);
    expect(result.state.phase).toBe("waiting-to-board");
  });

  it("without the platform's shape, the same spot is still the walk", () => {
    const result = tick(freshTransitTickState(NOW), xy(-150, -4), NOW + 60_000, {
      stopAreas: {},
    });
    expect(result.state.currentLegIndex).toBe(0);
  });

  it("keeps waiting while the rider walks the length of the platform", () => {
    const waiting: TransitTickState = {
      ...freshTransitTickState(NOW),
      currentLegIndex: 1,
      phase: "waiting-to-board",
    };
    // 150 m east along the platform is a tenth of the ride.
    const result = tick(waiting, xy(150, 2), NOW + 5 * 60_000);
    expect(result.state.phase).toBe("waiting-to-board");
    expect(result.events.filter((e) => e.type === "board")).toEqual([]);
  });

  it("boards once the rider leaves the platform along the line", () => {
    const waiting: TransitTickState = {
      ...freshTransitTickState(NOW),
      currentLegIndex: 1,
      phase: "waiting-to-board",
    };
    const result = tick(waiting, xy(400, 0), NOW + 23 * 60_000);
    expect(result.state.phase).toBe("riding");
    expect(result.events.map((e) => e.type)).toContain("board");
  });

  it("does not fall back to the walk while the rider stands on the platform", () => {
    const justArrived: TransitTickState = {
      ...freshTransitTickState(NOW),
      currentLegIndex: 1,
      phase: "waiting-to-board",
      legEnteredAtMs: NOW + 60_000,
    };
    // Right where the walk's access path meets the platform.
    const result = tick(justArrived, xy(-150, -6), NOW + 90_000);
    expect(result.state.currentLegIndex).toBe(1);
  });

  it("alights wherever along the arrival platform the train halts", () => {
    const riding: TransitTickState = {
      ...freshTransitTickState(NOW),
      currentLegIndex: 1,
      phase: "riding",
    };
    // 150 m past the quay point, still on the platform.
    const result = tick(riding, xy(1650, 1), NOW + 25 * 60_000);
    expect(result.state.currentLegIndex).toBe(2);
    expect(
      result.events.map((e) => e.type).filter((type) => type === "alight" || type === "transfer"),
    ).toEqual(["alight", "transfer"]);
  });

  it("arrives within a few metres of the destination, not a tenth of the walk early", () => {
    const walking: TransitTickState = {
      ...freshTransitTickState(NOW),
      currentLegIndex: 2,
      phase: "walking",
    };
    expect(tick(walking, xy(1500, 440), NOW + 30 * 60_000).state.phase).toBe("walking");
    const arrived = tick(walking, xy(1500, 485), NOW + 31 * 60_000);
    expect(arrived.state.phase).toBe("arrived");
    expect(arrived.events.map((e) => e.type)).toEqual(["arrival"]);
  });

  it("reports the engine's leg and phase as follow-along progress", () => {
    const state: TransitTickState = {
      ...freshTransitTickState(NOW),
      currentLegIndex: 1,
      phase: "waiting-to-board",
    };
    const progress = transitProgressFromTick(state, prepareTransitProgress(trip()), xy(150, 2));
    expect(progress).toMatchObject({
      currentLegIndex: 1,
      phase: "waiting-to-board",
      arrived: false,
    });
    expect(progress.fractionAlongLeg).toBeCloseTo(0.1, 2);
  });
});

describe("a transfer inside one station", () => {
  const P1 = { name: "Hbf", stopId: "mo:de:1:100:1:1", platformCode: "1", lat: LAT, lng: LNG };
  const P3 = {
    name: "Hbf",
    stopId: "mo:de:1:100:2:3",
    platformCode: "3",
    lat: xy(0, 60)[1],
    lng: xy(0, 60)[0],
  };
  const transfer = {
    legs: [
      {
        mode: "rail",
        tripId: "rb-1",
        from: { name: "Vorort", stopId: "x", lat: xy(-3000, 0)[1], lng: xy(-3000, 0)[0] },
        to: P1,
        startTime: minutes(0),
        endTime: minutes(5),
        geometry: { type: "LineString", coordinates: [xy(-3000, 0), xy(0, 0)] },
      },
      {
        mode: "walking",
        from: P1,
        to: P3,
        startTime: minutes(5),
        endTime: minutes(9),
        geometry: { type: "LineString", coordinates: [xy(0, 0), xy(40, 0), xy(40, 60), xy(0, 60)] },
        steps: [{ distanceMeters: 140 }],
      },
      {
        mode: "rail",
        tripId: "ice-1",
        from: P3,
        to: { name: "Fern", stopId: "y", lat: xy(0, 9000)[1], lng: xy(0, 9000)[0] },
        startTime: minutes(10),
        endTime: minutes(40),
        geometry: { type: "LineString", coordinates: [xy(0, 60), xy(0, 9000)] },
      },
    ],
  } as unknown as TripItinerary;
  const stationOnly: TransitStopAreaIndex = {
    [`${P3.stopId}|${P3.platformCode}`]: {
      stopId: P3.stopId,
      platform: [],
      station: [
        {
          type: "polygon",
          coordinates: [xy(-300, -200), xy(300, -200), xy(300, 250), xy(-300, 250)],
          bufferMeters: 10,
        },
      ],
      source: "osm",
    },
  };

  it("does not count the station it starts in as the next platform", () => {
    const walking: TransitTickState = {
      ...freshTransitTickState(NOW),
      currentLegIndex: 1,
      phase: "walking",
    };
    const result = processTransitFix({
      itinerary: transfer,
      captures: [],
      state: walking,
      fix: { coords: xy(5, -8), accuracy: 5, timestampMs: NOW + 5 * 60_000 },
      nowMs: NOW + 5 * 60_000,
      options: { ...DEFAULT_TRANSIT_TICK_OPTIONS, itineraryFingerprint: "fp" },
      stopAreas: stationOnly,
    });
    expect(result.state.currentLegIndex).toBe(1);
  });
});
