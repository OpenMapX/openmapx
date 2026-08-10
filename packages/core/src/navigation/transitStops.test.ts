import { describe, expect, it } from "vitest";
import { captureTransitLegStops, sliceJourneyToLeg } from "./transitStops";

const s = (stopId: string) => ({ stopId, name: stopId });

describe("sliceJourneyToLeg", () => {
  it("slices from the board stop to the alight stop inclusive", () => {
    const stops = [s("A"), s("B"), s("C"), s("D")];
    expect(sliceJourneyToLeg(stops, "B", "C").map((x) => x.stopId)).toEqual(["B", "C"]);
  });

  it("matches the alight stop after the board stop on circular routes", () => {
    // A appears twice; boarding at the second A must not match the first as alight.
    const stops = [s("A"), s("B"), s("A"), s("C")];
    expect(sliceJourneyToLeg(stops, "B", "A").map((x) => x.stopId)).toEqual(["B", "A"]);
  });

  it("falls back to the whole list when endpoints are missing", () => {
    const stops = [s("A"), s("B")];
    expect(sliceJourneyToLeg(stops, "X", "Y")).toEqual(stops);
    expect(sliceJourneyToLeg(stops)).toEqual(stops);
  });
});

describe("captureTransitLegStops", () => {
  const journey = [
    { stopId: "a", name: "Alpha", lat: 50.1, lng: 8.6, scheduledDeparture: "10:00" },
    { stopId: "b", name: "Beta", lat: 50.2, lng: 8.7, platform: "3" },
    { stopId: "c", name: "Gamma", lat: 50.3, lng: 8.8, canceled: true },
    { stopId: "d", name: "Delta", lat: 50.4, lng: 8.9 },
  ];
  const legs = [
    { from: { stopId: "x" }, to: { stopId: "y" } }, // walking leg: no tripId
    { tripId: "t1", from: { stopId: "b" }, to: { stopId: "c" } },
  ];

  it("captures only transit legs, keeping the leg index of the itinerary", () => {
    const captures = captureTransitLegStops(legs, { t1: journey }, 1_000);
    expect(captures).toHaveLength(1);
    expect(captures[0].legIndex).toBe(1);
    expect(captures[0].tripId).toBe("t1");
  });

  it("slices from board through alight inclusively", () => {
    const [capture] = captureTransitLegStops(legs, { t1: journey }, 1_000);
    expect(capture.stops.map((s) => s.stopId)).toEqual(["b", "c"]);
    expect(capture.status).toBe("captured");
  });

  it("keeps schedule, live, platform and cancellation fields", () => {
    const [capture] = captureTransitLegStops(
      [{ tripId: "t1", from: { stopId: "a" }, to: { stopId: "c" } }],
      { t1: journey },
      1_000,
    );
    expect(capture.stops[0].scheduledDeparture).toBe("10:00");
    expect(capture.stops[1].platform).toBe("3");
    expect(capture.stops[2].canceled).toBe(true);
  });

  it("drops journey metadata the engine does not need", () => {
    const noisy = [
      { stopId: "b", name: "Beta", lat: 50.2, lng: 8.7, remarks: ["x"], formation: {} },
    ];
    const [capture] = captureTransitLegStops(
      [{ tripId: "t1", from: { stopId: "b" }, to: { stopId: "b" } }],
      { t1: noisy },
      1_000,
    );
    expect(capture.stops[0]).not.toHaveProperty("remarks");
    expect(capture.stops[0]).not.toHaveProperty("formation");
  });

  it("records a typed missing capture rather than fabricating stops", () => {
    const [capture] = captureTransitLegStops(
      [{ tripId: "t9", from: { stopId: "b" }, to: { stopId: "c" } }],
      {},
      1_000,
    );
    expect(capture.status).toBe("missing");
    expect(capture.stops).toEqual([]);
  });

  it("treats an empty journey as missing", () => {
    const [capture] = captureTransitLegStops(
      [{ tripId: "t1", from: { stopId: "b" }, to: { stopId: "c" } }],
      { t1: [] },
      1_000,
    );
    expect(capture.status).toBe("missing");
  });

  it("stamps every capture with the same capture time", () => {
    const captures = captureTransitLegStops(
      [
        { tripId: "t1", from: { stopId: "a" }, to: { stopId: "b" } },
        { tripId: "t1", from: { stopId: "c" }, to: { stopId: "d" } },
      ],
      { t1: journey },
      4_242,
    );
    expect(captures.every((c) => c.capturedAtMs === 4_242)).toBe(true);
  });

  it("skips stops without usable coordinates", () => {
    const broken = [
      { stopId: "b", name: "Beta", lat: 50.2, lng: 8.7 },
      { stopId: "bad", name: "Nowhere", lat: 999, lng: 8.8 },
      { stopId: "c", name: "Gamma", lat: 50.3, lng: 8.8 },
    ];
    const [capture] = captureTransitLegStops(
      [{ tripId: "t1", from: { stopId: "b" }, to: { stopId: "c" } }],
      { t1: broken },
      1_000,
    );
    expect(capture.stops.map((s) => s.stopId)).toEqual(["b", "c"]);
  });

  it("matches the alight stop after the board stop on a circular route", () => {
    const ring = [
      { stopId: "hub", name: "Hub", lat: 50, lng: 8 },
      { stopId: "b", name: "Beta", lat: 50.1, lng: 8.1 },
      { stopId: "hub", name: "Hub", lat: 50, lng: 8 },
    ];
    const [capture] = captureTransitLegStops(
      [{ tripId: "t1", from: { stopId: "b" }, to: { stopId: "hub" } }],
      { t1: ring },
      1_000,
    );
    expect(capture.stops.map((s) => s.stopId)).toEqual(["b", "hub"]);
  });
});
