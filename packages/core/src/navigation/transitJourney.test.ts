import type { TripItinerary } from "@openmapx/mobility-core/transit";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_TRANSIT_TICK_OPTIONS,
  freshTransitTickState,
  processTransitFix,
  type TransitTickInput,
  transitProgressFromTick,
} from "./processTransitFix";
import { prepareTransitProgress } from "./transitProgress";

const now = 1800000000000;
const trip = {
  legs: [
    {
      mode: "bus",
      tripId: "t1",
      route: { shortName: "12" },
      startTime: new Date(now - 600000).toISOString(),
      endTime: new Date(now + 600000).toISOString(),
      from: { name: "A", stopId: "a", lng: 0, lat: 0 },
      to: { name: "B", stopId: "b", lng: 0.02, lat: 0 },
      geometry: {
        type: "LineString",
        coordinates: [
          [0, 0],
          [0.02, 0],
        ],
      },
    },
  ],
  startTime: "",
  endTime: "",
  duration: 1200,
  transfers: 0,
  walkDistance: 0,
} as TripItinerary;
function tick(extra: Partial<TransitTickInput> = {}) {
  return processTransitFix({
    itinerary: trip,
    captures: [],
    state: freshTransitTickState(now, trip),
    nowMs: now,
    options: { ...DEFAULT_TRANSIT_TICK_OPTIONS, itineraryFingerprint: "trip" },
    ...extra,
  });
}
describe("selected transit journey", () => {
  it("starts a ride-only trip waiting and never infers boarding from projection", () => {
    const r = tick({ fix: { coords: [0.019, 0], accuracy: 5, timestampMs: now } });
    expect(r.state.phase).toBe("waiting-to-board");
    expect(r.state.currentLegIndex).toBe(0);
  });
  it("holds the chosen ride through arbitrary timetable expiry and GPS gaps", () => {
    const start = tick({ action: { type: "board", legIndex: 0 } }).state;
    const r = tick({ state: start, nowMs: now + 3600000 });
    expect(r.state.phase).toBe("riding");
    expect(r.state.currentLegIndex).toBe(0);
    expect(r.needsReplan).toBe(false);
    expect(r.events.some((e) => e.type === "arrival")).toBe(false);
  });
  it("only rider alighting finishes a ride, and supports undo", () => {
    const board = tick({ action: { type: "board", legIndex: 0 } });
    expect(board.state.phase).toBe("riding");
    const alight = tick({ state: board.state, action: { type: "alight", legIndex: 0 } });
    expect(alight.state.phase).toBe("arrived");
    const undo = tick({ state: alight.state, action: { type: "undo", legIndex: 0 } });
    expect(undo.state.phase).toBe("riding");
  });
  it("rejects a stale action without skipping legs", () => {
    const r = tick({ action: { type: "board", legIndex: 3 } });
    expect(r.state.phase).toBe("waiting-to-board");
    expect(r.actionRejected).toBe(true);
  });
  it.each([
    { timestampMs: now - 31000 },
    { timestampMs: now + 6000 },
    { timestampMs: now, coasted: true },
    { timestampMs: now, accuracy: 101 },
  ])("never publishes rejected coordinates %j", (bad) => {
    const r = tick({ fix: { coords: [0.019, 0], accuracy: 5, ...bad } });
    expect(r.state.lastAcceptedFix).toBeUndefined();
    expect(r.rejectedReason).toBeDefined();
  });
  it("does not announce arrival from a distant projection onto a final walk", () => {
    const walking = {
      ...trip,
      legs: [{ ...trip.legs[0], mode: "walking", tripId: undefined, route: undefined }],
    } as TripItinerary;
    const r = tick({
      itinerary: walking,
      fix: { coords: [0.025, 0.02], accuracy: 5, timestampMs: now },
    });
    expect(r.state.phase).toBe("walking");
  });
  it("keeps rider position separate from the line during a detour", () => {
    const r = tick({
      action: { type: "board", legIndex: 0 },
      fix: { coords: [0.01, 0.01], accuracy: 5, timestampMs: now },
    });
    const p = transitProgressFromTick(r.state, prepareTransitProgress(trip), [0.01, 0.01]);
    expect(p.position).toEqual([0.01, 0.01]);
    expect(p.confidence).toBe("uncertain");
  });
});
it("does not treat a journey missing the selected endpoints as captured", async () => {
  const { captureTransitLegStops } = await import("./transitStops");
  const c = captureTransitLegStops(
    trip.legs,
    { t1: [{ stopId: "elsewhere", lat: 0, lng: 0 }] },
    now,
  );
  expect(c[0].status).toBe("missing");
  expect(c[0].stops).toEqual([]);
});
it("requires a separate confirmation for adjacent rides and can continue on an interlined service", () => {
  const two = {
    ...trip,
    legs: [trip.legs[0], { ...trip.legs[0], tripId: "t2", interlineWithPrevious: true }],
  };
  const boarded = tick({ itinerary: two, action: { type: "board", legIndex: 0 } }).state;
  const continued = tick({
    itinerary: two,
    state: boarded,
    action: { type: "continue", legIndex: 0 },
  });
  expect(continued.state).toMatchObject({ currentLegIndex: 1, phase: "riding" });
  const normal = { ...two, legs: [two.legs[0], { ...two.legs[1], interlineWithPrevious: false }] };
  expect(
    tick({ itinerary: normal, state: boarded, action: { type: "continue", legIndex: 0 } })
      .actionRejected,
  ).toBe(true);
  expect(
    tick({ itinerary: normal, state: boarded, action: { type: "alight", legIndex: 0 } }).state,
  ).toMatchObject({ currentLegIndex: 1, phase: "waiting-to-board" });
});
it("does not declare arrival after getting off far from a ride-only destination", () => {
  const boarded = tick({
    action: { type: "board", legIndex: 0 },
    fix: { coords: [0, 0], accuracy: 5, timestampMs: now },
  }).state;
  const off = tick({ state: boarded, action: { type: "alight", legIndex: 0 } });
  expect(off.state.offPlan).toBe(true);
  expect(off.state.phase).not.toBe("arrived");
});
it("anchors a ride started mid-route, but a subsequent impossible GPS jump does not skip stops", () => {
  const captures = [
    {
      legIndex: 0,
      tripId: "t1",
      capturedAtMs: now,
      status: "captured" as const,
      stops: [
        { stopId: "a", name: "A", lat: 0, lng: 0 },
        { stopId: "m", name: "Middle", lat: 0, lng: 0.01 },
        { stopId: "b", name: "B", lat: 0, lng: 0.02 },
      ],
    },
  ];
  const r = tick({
    captures,
    action: { type: "board", legIndex: 0 },
    fix: { coords: [0.012, 0], accuracy: 5, timestampMs: now },
  });
  expect(r.state.stopCursor).toBe(2);
  const jumped = tick({
    captures,
    state: r.state,
    fix: { coords: [0.019, 0], accuracy: 5, timestampMs: now + 1000 },
    nowMs: now + 1000,
  });
  expect(jumped.state.alongMeters).toBe(r.state.alongMeters);
  expect(jumped.state.progressConfidence).toBe("uncertain");
});
it("uses the next actual stop area even when the service shape is inaccurate", () => {
  const badShape: TripItinerary = {
    ...trip,
    legs: [
      {
        ...trip.legs[0],
        geometry: {
          type: "LineString" as const,
          coordinates: [
            [0, 0.01],
            [0.02, 0.01],
          ],
        },
      },
    ],
  };
  const captures = [
    {
      legIndex: 0,
      tripId: "t1",
      capturedAtMs: now,
      status: "captured" as const,
      stops: [
        { stopId: "a", name: "A", lat: 0, lng: 0 },
        { stopId: "m", name: "Middle", lat: 0, lng: 0.01 },
        { stopId: "b", name: "B", lat: 0, lng: 0.02 },
      ],
    },
  ];
  const r = tick({
    itinerary: badShape,
    captures,
    action: { type: "board", legIndex: 0 },
    fix: { coords: [0.01, 0], accuracy: 5, timestampMs: now },
  });
  expect(r.state.stopCursor).toBe(2);
  expect(r.state.phase).toBe("riding");
});
it("anchors a late boarding confirmation even with an earlier walking GPS fix", () => {
  const waiting = tick({ fix: { coords: [0, 0], accuracy: 5, timestampMs: now } }).state;
  const r = tick({
    captures: [
      {
        legIndex: 0,
        tripId: "t1",
        capturedAtMs: now,
        status: "captured",
        stops: [
          { stopId: "a", name: "A", lat: 0, lng: 0 },
          { stopId: "b", name: "B", lat: 0, lng: 0.02 },
        ],
      },
    ],
    state: waiting,
    action: { type: "board", legIndex: 0 },
    fix: { coords: [0.015, 0], accuracy: 5, timestampMs: now + 1000 },
    nowMs: now + 1000,
  });
  expect(r.state.alongMeters).toBeGreaterThan(1000);
  expect(r.state.progressConfidence).toBe("gps");
});
it("resynchronizes stop progress after a detour and after a single forward GPS jump", () => {
  let state = tick({
    action: { type: "board", legIndex: 0 },
    fix: { coords: [0.001, 0], accuracy: 5, timestampMs: now },
  }).state;
  const capture = [
    {
      legIndex: 0,
      tripId: "t1",
      capturedAtMs: now,
      status: "captured" as const,
      stops: [
        { stopId: "a", name: "A", lat: 0, lng: 0 },
        { stopId: "m", name: "Mid", lat: 0, lng: 0.008 },
        { stopId: "n", name: "Next", lat: 0, lng: 0.015 },
        { stopId: "b", name: "B", lat: 0, lng: 0.02 },
      ],
    },
  ];
  state = tick({
    captures: capture,
    state,
    fix: { coords: [0.001, 0], accuracy: 5, timestampMs: now + 1000 },
    nowMs: now + 1000,
  }).state;
  state = tick({
    captures: capture,
    state,
    fix: { coords: [0.012, 0.003], accuracy: 5, timestampMs: now + 61000 },
    nowMs: now + 61000,
  }).state;
  state = tick({
    captures: capture,
    state,
    fix: { coords: [0.014, 0], accuracy: 5, timestampMs: now + 62000 },
    nowMs: now + 62000,
  }).state;
  state = tick({
    captures: capture,
    state,
    fix: { coords: [0.0141, 0], accuracy: 5, timestampMs: now + 63000 },
    nowMs: now + 63000,
  }).state;
  expect(state.alongMeters).toBeGreaterThan(1400);
  expect(state.stopCursor).toBe(2);
  expect(state.progressConfidence).toBe("gps");
});
it("clears an early-alight recovery warning on boarding the next selected service", () => {
  const next = { ...trip, legs: [trip.legs[0], { ...trip.legs[0], tripId: "t2" }] };
  const board = tick({
    itinerary: next,
    action: { type: "board", legIndex: 0 },
    fix: { coords: [0, 0], accuracy: 5, timestampMs: now },
  }).state;
  const off = tick({
    itinerary: next,
    state: board,
    action: { type: "alight", legIndex: 0 },
  }).state;
  expect(off.offPlan).toBe(true);
  expect(
    tick({ itinerary: next, state: off, action: { type: "board", legIndex: 1 } }).state.offPlan,
  ).toBe(false);
});

it("anchors a stop capture arriving midride and rejects an isolated forward jump", () => {
  const captures = [
    {
      legIndex: 0,
      tripId: "t1",
      status: "captured" as const,
      capturedAtMs: now,
      stops: [
        { stopId: "a", name: "A", lat: 0, lng: 0 },
        { stopId: "m", name: "Mid", lat: 0, lng: 0.008 },
        { stopId: "n", name: "Next", lat: 0, lng: 0.018 },
        { stopId: "b", name: "B", lat: 0, lng: 0.02 },
      ],
    },
  ];
  let state = tick({
    action: { type: "board", legIndex: 0 },
    fix: { coords: [0.01, 0], accuracy: 5, timestampMs: now },
  }).state;
  state = tick({
    state,
    captures,
    fix: { coords: [0.0101, 0], accuracy: 5, timestampMs: now + 1000 },
    nowMs: now + 1000,
  }).state;
  expect(state.stopCursor).toBe(2);
  expect(state.progressConfidence).toBe("gps");
  const along = state.alongMeters;
  state = tick({
    state,
    captures,
    fix: { coords: [0.019, 0], accuracy: 5, timestampMs: now + 2000 },
    nowMs: now + 2000,
  }).state;
  expect(state.alongMeters).toBe(along);
  expect(state.stopCursor).toBe(2);
  expect(state.progressConfidence).toBe("uncertain");
  state = tick({
    state,
    captures,
    fix: { coords: [0.0102, 0], accuracy: 5, timestampMs: now + 3000 },
    nowMs: now + 3000,
  }).state;
  expect(state.stopCursor).toBe(2);
});

it("does not sound the next-stop alarm at boarding on a long nonstop ride", () => {
  const captures = [
    {
      legIndex: 0,
      tripId: "t1",
      capturedAtMs: now,
      status: "captured" as const,
      stops: [
        { stopId: "a", name: "A", lat: 0, lng: 0 },
        { stopId: "b", name: "B", lat: 0, lng: 0.02 },
      ],
    },
  ];
  const board = tick({
    captures,
    action: { type: "board", legIndex: 0 },
    fix: { coords: [0, 0], accuracy: 5, timestampMs: now },
  });
  expect(board.events.some((e) => e.type === "approaching-alight")).toBe(false);
  const near = tick({
    captures,
    state: board.state,
    fix: { coords: [0.018, 0], accuracy: 5, timestampMs: now + 60000 },
    nowMs: now + 60000,
  });
  expect(near.events.some((e) => e.type === "approaching-alight")).toBe(true);
});
