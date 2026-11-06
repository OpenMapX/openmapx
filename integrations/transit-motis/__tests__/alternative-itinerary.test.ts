import type { Itinerary, Leg } from "@motis-project/motis-client";
import { describe, expect, it } from "vitest";
import { alternativeReplacement } from "../alternative-itinerary.js";

const place = { name: "A", lat: 50, lon: 6, stopId: "a" };
const leg = (mode: string, start: string, end: string, extra = {}) =>
  ({
    mode,
    startTime: `2026-11-06T${start}:00Z`,
    endTime: `2026-11-06T${end}:00Z`,
    from: place,
    to: place,
    ...(mode === "WALK" ? {} : { routeShortName: mode, tripId: mode }),
    ...extra,
  }) as Leg;
const chain = [
  leg("WALK", "20:50", "20:51"),
  leg("REGIONAL_RAIL", "20:51", "21:44"),
  leg("WALK", "21:44", "21:45"),
];
const parent = {
  legs: [
    leg("WALK", "20:42", "20:44"),
    leg("HIGHSPEED_RAIL", "20:44", "21:22"),
    leg("WALK", "21:22", "21:23"),
  ],
} as Itinerary;
const context = { time: "2026-11-06T20:41:00Z" };
describe("validated alternative replacement", () => {
  it("accepts the full RE1 incident chain and includes both street legs", () =>
    expect(alternativeReplacement(parent, 1, chain, context)).toEqual({
      fromLegIndex: 0,
      toLegIndex: 2,
    }));
  it.each([
    { ...context, modes: ["HIGHSPEED_RAIL"] },
    { ...context, time: "2026-11-06T20:52:00Z" },
    { ...context, arriveBy: true, time: "2026-11-06T21:44:00Z" },
  ])("rejects alternatives outside the original query", (ctx) =>
    expect(alternativeReplacement(parent, 1, chain, ctx)).toBeNull(),
  );
  it.each([
    { cancelled: true },
    { wheelchairAccessible: "NOT_ACCESSIBLE" },
    { bikesAllowed: false },
  ])("rejects contradicted requirements", (extra) => {
    const candidate = [chain[0], { ...chain[1], ...extra }, chain[2]] as Leg[];
    expect(
      alternativeReplacement(parent, 1, candidate, {
        ...context,
        wheelchair: true,
        requireBikeTransport: true,
      }),
    ).toBeNull();
  });
  it("rejects disconnected chains and backwards time", () => {
    expect(
      alternativeReplacement(
        parent,
        1,
        [{ ...chain[0], from: { ...place, stopId: "elsewhere" } }, ...chain.slice(1)],
        context,
      ),
    ).toBeNull();
    expect(
      alternativeReplacement(
        parent,
        1,
        [{ ...chain[0], endTime: "bad" }, ...chain.slice(1)],
        context,
      ),
    ).toBeNull();
  });
  it("replaces an entire interlined run", () => {
    const p = {
      legs: [
        parent.legs[0],
        parent.legs[1],
        leg("HIGHSPEED_RAIL", "21:22", "21:30", { interlineWithPreviousLeg: true }),
        leg("WALK", "21:30", "21:31"),
      ],
    } as Itinerary;
    expect(alternativeReplacement(p, 1, chain, context)).toEqual({
      fromLegIndex: 0,
      toLegIndex: 3,
    });
  });
  it("rejects changing a walk transfer into a bike ride", () =>
    expect(
      alternativeReplacement(
        parent,
        1,
        [{ ...chain[0], mode: "BIKE" }, ...chain.slice(1)],
        context,
      ),
    ).toBeNull());
});

it("keeps preceding and following rides and checks transfer connections", () => {
  const p = {
    legs: [
      leg("REGIONAL_RAIL", "19:00", "20:40"),
      leg("WALK", "20:40", "20:42"),
      parent.legs[1],
      leg("WALK", "21:22", "21:25"),
      leg("REGIONAL_RAIL", "21:50", "22:20"),
    ],
  } as Itinerary;
  expect(alternativeReplacement(p, 2, chain, { ...context, time: "2026-11-06T18:50:00Z" })).toEqual(
    { fromLegIndex: 1, toLegIndex: 3 },
  );
  expect(
    alternativeReplacement(p, 2, chain, {
      ...context,
      time: "2026-11-06T18:50:00Z",
      maxTransfers: 1,
    }),
  ).toBeNull();
  const missed = { ...p, legs: [...p.legs.slice(0, 4), leg("REGIONAL_RAIL", "21:40", "22:20")] };
  expect(
    alternativeReplacement(missed, 2, chain, { ...context, time: "2026-11-06T18:50:00Z" }),
  ).toBeNull();
});
it("accepts an interlined replacement but rejects disconnected transit runs", () => {
  const interlined = [
    chain[0],
    leg("REGIONAL_RAIL", "20:51", "21:10"),
    leg("REGIONAL_RAIL", "21:10", "21:44", { interlineWithPreviousLeg: true }),
    chain[2],
  ];
  expect(alternativeReplacement(parent, 1, interlined, context)).toEqual({
    fromLegIndex: 0,
    toLegIndex: 2,
  });
  expect(
    alternativeReplacement(
      parent,
      1,
      interlined.map((l) => ({ ...l, interlineWithPreviousLeg: false })),
      context,
    ),
  ).toBeNull();
});
