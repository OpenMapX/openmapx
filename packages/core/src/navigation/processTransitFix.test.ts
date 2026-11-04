import type { TripItinerary } from "@openmapx/mobility-core/transit";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_TRANSIT_TICK_OPTIONS,
  freshTransitTickState,
  processTransitFix,
  type TransitTickInput,
  type TransitTickState,
} from "./processTransitFix";

const NOW = 1700000000000;
function itinerary(): TripItinerary {
  return {
    duration: 1500,
    startTime: new Date(NOW).toISOString(),
    endTime: new Date(NOW + 1500000).toISOString(),
    transfers: 0,
    walkDistance: 200,
    legs: [
      {
        mode: "walking",
        startTime: "",
        endTime: "",
        from: { name: "Home", lat: 0, lng: 0 },
        to: { name: "Board", stopId: "a", lat: 0, lng: 0.002 },
        geometry: {
          type: "LineString",
          coordinates: [
            [0, 0],
            [0.002, 0],
          ],
        },
        steps: [
          { instruction: "DEPART", distanceMeters: 100 },
          { instruction: "LEFT", distanceMeters: 120 },
        ],
      },
      {
        mode: "bus",
        tripId: "trip-1",
        route: { shortName: "12", longName: "Line 12" },
        startTime: new Date(NOW + 300000).toISOString(),
        endTime: new Date(NOW + 1200000).toISOString(),
        from: { name: "Board", stopId: "a", lat: 0, lng: 0.002 },
        to: { name: "Alight", stopId: "b", lat: 0, lng: 0.02 },
        geometry: {
          type: "LineString",
          coordinates: [
            [0.002, 0],
            [0.02, 0],
          ],
        },
      },
      {
        mode: "walking",
        startTime: "",
        endTime: "",
        from: { name: "Alight", stopId: "b", lat: 0, lng: 0.02 },
        to: { name: "Destination", lat: 0, lng: 0.022 },
        geometry: {
          type: "LineString",
          coordinates: [
            [0.02, 0],
            [0.022, 0],
          ],
        },
      },
    ],
  };
}
function tick(overrides: Partial<TransitTickInput> = {}) {
  return processTransitFix({
    itinerary: itinerary(),
    captures: [],
    state: freshTransitTickState(NOW),
    nowMs: NOW,
    options: { ...DEFAULT_TRANSIT_TICK_OPTIONS, itineraryFingerprint: "trip" },
    ...overrides,
  });
}
function fix(lng: number, lat = 0, at = NOW) {
  return { coords: [lng, lat] as [number, number], accuracy: 5, timestampMs: at };
}
function atRide(): TransitTickState {
  return { ...freshTransitTickState(NOW), currentLegIndex: 1, phase: "riding" };
}
describe("physical walking progress", () => {
  it("enters waiting on reaching the boarding area even before departure", () => {
    expect(tick({ fix: fix(0.002) }).state).toMatchObject({
      currentLegIndex: 1,
      phase: "waiting-to-board",
    });
  });
  it("does not jump onto a later walk that happens to be closer", () => {
    expect(tick({ fix: fix(0.021) }).state.currentLegIndex).toBe(0);
  });
  it("only advances steps inside the walking corridor", () => {
    expect(tick({ fix: fix(0.0015, 0.01) }).state.currentWalkStepIndex).toBe(0);
  });
  it("keeps committed maneuvers monotonic through jitter", () => {
    const first = tick({ fix: fix(0.0012) }).state;
    expect(first.currentWalkStepIndex).toBe(1);
    expect(
      tick({ state: first, fix: fix(0.0005, 0, NOW + 1000), nowMs: NOW + 1000 }).state
        .currentWalkStepIndex,
    ).toBe(1);
  });
  it("does not declare arrival on projecting past the final endpoint from far away", () => {
    expect(
      tick({ state: { ...atRide(), currentLegIndex: 2, phase: "walking" }, fix: fix(0.03, 0.01) })
        .state.phase,
    ).toBe("walking");
  });
  it("finishes only inside the actual destination area", () => {
    expect(
      tick({ state: { ...atRide(), currentLegIndex: 2, phase: "walking" }, fix: fix(0.022) }).state
        .phase,
    ).toBe("arrived");
  });
});
describe("rider-owned ride boundaries", () => {
  it("does not infer boarding even after scheduled departure and movement along the line", () => {
    const r = tick({
      state: { ...atRide(), phase: "waiting-to-board" },
      fix: fix(0.015),
      nowMs: NOW + 600000,
    });
    expect(r.state.phase).toBe("waiting-to-board");
    expect(r.needsReplan).toBe(false);
  });
  it("allows confirmation from the access walk and emits one boarding event", () => {
    const r = tick({ action: { type: "board", legIndex: 1 } });
    expect(r.state).toMatchObject({ phase: "riding", currentLegIndex: 1 });
    expect(r.events.filter((e) => e.type === "board")).toHaveLength(1);
    expect(tick({ state: r.state, action: { type: "board", legIndex: 1 } }).actionRejected).toBe(
      true,
    );
  });
  it("holds riding at the actual alight stop until confirmation", () => {
    const r = tick({ state: atRide(), fix: fix(0.02) });
    expect(r.state.phase).toBe("riding");
    expect(r.events.some((e) => e.type === "alight")).toBe(false);
  });
  it("keeps the final walk after alighting and emits a transfer", () => {
    const r = tick({ state: atRide(), action: { type: "alight", legIndex: 1 }, fix: fix(0.02) });
    expect(r.state).toMatchObject({ phase: "walking", currentLegIndex: 2 });
    expect(r.events).toContainEqual(
      expect.objectContaining({ type: "transfer", fromLegIndex: 1, toLegIndex: 2 }),
    );
    expect(r.events.some((e) => e.type === "arrival")).toBe(false);
  });
  it("supports bounded undo without undoing other legs", () => {
    const r = tick({ action: { type: "board", legIndex: 1 } });
    expect(
      tick({ state: r.state, action: { type: "undo", legIndex: 1 }, nowMs: NOW + 119000 }).state
        .phase,
    ).toBe("walking");
    expect(
      tick({ state: r.state, action: { type: "undo", legIndex: 1 }, nowMs: NOW + 121000 })
        .actionRejected,
    ).toBe(true);
  });
  it("does not mutate its input state", () => {
    const s = atRide();
    const original = structuredClone(s);
    tick({ state: s, action: { type: "alight", legIndex: 1 } });
    expect(s).toEqual(original);
  });
  it("flags a changed platform once", () => {
    const trip = itinerary();
    trip.legs[1].from.platformCode = "4";
    trip.legs[1].from.scheduledPlatformCode = "3";
    const r = tick({
      itinerary: trip,
      state: { ...atRide(), phase: "waiting-to-board" },
      fix: fix(0.002),
    });
    expect(r.events.filter((e) => e.type === "platform-change")).toHaveLength(1);
    expect(
      tick({
        itinerary: trip,
        state: r.state,
        fix: fix(0.002, 0, NOW + 1000),
        nowMs: NOW + 1000,
      }).events.filter((e) => e.type === "platform-change"),
    ).toHaveLength(0);
  });
});
describe("no-fix and rejected callbacks", () => {
  it.each(["walking", "waiting-to-board", "riding"] as const)(
    "holds %s through an arbitrary schedule gap",
    (phase) => {
      const state = {
        ...freshTransitTickState(NOW),
        currentLegIndex: phase === "walking" ? 0 : 1,
        phase,
      };
      const r = tick({ state, nowMs: NOW + 3600000 });
      expect(r.state.phase).toBe(phase);
      expect(r.state.currentLegIndex).toBe(state.currentLegIndex);
      expect(r.events).toEqual([]);
      expect(r.needsReplan).toBe(false);
    },
  );
  it.each([
    { coords: [NaN, 0] },
    { accuracy: 101 },
    { timestampMs: NOW - 31000 },
    { timestampMs: NOW + 6000 },
    { coasted: true },
  ])("does not replace the accepted fix with %j", (bad) => {
    const first = tick({ fix: fix(0.0005) }).state;
    const r = tick({ state: first, fix: { ...fix(0.001), ...bad } as never });
    expect(r.state.lastAcceptedFix).toEqual(first.lastAcceptedFix);
    expect(r.rejectedReason).toBeDefined();
  });
  it("ignores out-of-order callbacks", () => {
    const state = tick({ fix: fix(0.0005) }).state;
    expect(tick({ state, fix: fix(0.001) }).rejectedReason).toBe("out-of-order");
  });
});
