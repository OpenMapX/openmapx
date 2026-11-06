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
      { stopId: "c", name: "Gamma", lat: 50.3, lng: 8.8 },
    ];
    const [capture] = captureTransitLegStops(
      [{ tripId: "t1", from: { stopId: "b" }, to: { stopId: "c" } }],
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
it("updates stop predictions only when the captured occurrence sequence is unchanged", async () => {
  const { refreshTransitCaptures } = await import("./transitStops");
  const legs = [{ tripId: "t1", from: { stopId: "a" }, to: { stopId: "b" } }];
  const original = captureTransitLegStops(
    legs,
    {
      t1: [
        { stopId: "a", name: "A", lat: 0, lng: 0 },
        { stopId: "b", name: "B", lat: 0, lng: 0.01 },
      ],
    },
    1000,
  );
  const next = refreshTransitCaptures(
    original,
    legs,
    {
      t1: [
        { stopId: "a", lat: 0, lng: 0, platform: "4" },
        { stopId: "b", lat: 0, lng: 0.01, expectedArrival: "2026-11-04T10:00:00Z" },
      ],
    },
    2000,
  );
  expect(next[0].stops[0].name).toBe("A");
  expect(next[0].stops[0].platform).toBe("4");
  expect(next[0].stops[1].expectedArrival).toBe("2026-11-04T10:00:00Z");
  expect(
    refreshTransitCaptures(
      original,
      legs,
      {
        t1: [
          { stopId: "a", lat: 0, lng: 0 },
          { stopId: "x", lat: 0, lng: 0.005 },
          { stopId: "b", lat: 0, lng: 0.01 },
        ],
      },
      2000,
    )[0],
  ).toBe(original[0]);
});

it("captures the scheduled boarding occurrence on a loop instead of its earlier visit", () => {
  const [capture] = captureTransitLegStops(
    [
      {
        tripId: "loop",
        from: { stopId: "a" },
        to: { stopId: "b" },
        scheduledStartTime: "2026-11-04T10:30:00Z",
      },
    ],
    {
      loop: [
        {
          stopId: "a",
          name: "First lap",
          lat: 0,
          lng: 0,
          scheduledDeparture: "2026-11-04T10:00:00Z",
        },
        { stopId: "b", lat: 0, lng: 0.01 },
        {
          stopId: "a",
          name: "Second lap",
          lat: 0,
          lng: 0,
          scheduledDeparture: "2026-11-04T10:30:00Z",
        },
        { stopId: "b", lat: 0, lng: 0.01 },
      ],
    },
    1,
  );
  expect(capture.stops).toHaveLength(2);
  expect(capture.stops[0].name).toBe("Second lap");
});

it("selects captured event evidence and removes superseded bad platform state", async () => {
  const { selectLegPlatform, refreshTransitCaptures } = await import("./transitStops");
  const leg = {
    tripId: "t",
    from: { stopId: "a", platformCode: "37" },
    to: { stopId: "b", platformCode: "78" },
  };
  const evidence = { code: "3", kind: "correction" as const, sourceId: "siri" };
  const fresh = captureTransitLegStops(
    [leg],
    {
      t: [
        { stopId: "a", lat: 0, lng: 0, departurePlatform: evidence },
        { stopId: "b", lat: 0, lng: 1, arrivalPlatform: { ...evidence, code: "5 A-C" } },
      ],
    },
    2,
  );
  expect(selectLegPlatform(leg, 0, fresh, "departure")).toMatchObject({
    code: "3",
    changed: false,
  });
  expect(selectLegPlatform(leg, 0, fresh, "arrival").code).toBe("5 A-C");
  expect(selectLegPlatform({ ...leg, tripId: "other" }, 0, fresh, "departure").code).toBe("37");
  const old = captureTransitLegStops(
    [leg],
    {
      t: [
        { stopId: "a", lat: 0, lng: 0, platform: "37", scheduledPlatform: "37" },
        { stopId: "b", lat: 0, lng: 1, platform: "78", scheduledPlatform: "78" },
      ],
    },
    1,
  );
  const updated = refreshTransitCaptures(old, [leg], { t: fresh[0].stops }, 3);
  expect(updated[0].stops[0].scheduledPlatform).toBeUndefined();
  expect(selectLegPlatform(leg, 0, updated, "departure").code).toBe("3");
});

it("captures only bounded known evidence fields on initial load and refresh", async () => {
  const { transitLegCaptureSchema } = await import("./mobileProtocol");
  const { refreshTransitCaptures } = await import("./transitStops");
  const legs = [{ tripId: "t", from: { stopId: "a" }, to: { stopId: "b" } }];
  const stops = [
    {
      stopId: "a",
      name: "A",
      lat: 0,
      lng: 0,
      departurePlatform: {
        code: "3",
        kind: "correction" as const,
        sourceId: "siri",
        recordedAt: "x".repeat(100),
        futureField: "must not persist",
      },
    },
    { stopId: "b", name: "B", lat: 0, lng: 1 },
  ];
  const original = captureTransitLegStops(legs, { t: stops }, 1);
  expect(transitLegCaptureSchema.safeParse(original[0]).success).toBe(true);
  expect(original[0].stops[0].departurePlatform).toEqual({
    code: "3",
    kind: "correction",
    sourceId: "siri",
  });
  const malformed = stops[0].departurePlatform;
  if (!malformed) throw new Error("Missing fixture platform");
  malformed.code = "x".repeat(65);
  const updated = refreshTransitCaptures(original, legs, { t: stops }, 2);
  expect(updated[0].stops[0].departurePlatform).toBeUndefined();
  expect(transitLegCaptureSchema.safeParse(updated[0]).success).toBe(true);
});
