import {
  type ChainedTripSegment,
  resolveScheduleConstraints,
  type WaypointSchedule,
} from "@openmapx/core";
import { describe, expect, it } from "vitest";
import { composeBackwardTransitSchedule } from "../backward-chain-schedule.js";

function segment(fromIndex: number, startTime: string, endTime: string): ChainedTripSegment {
  return {
    fromIndex,
    toIndex: fromIndex + 1,
    itinerary: { startTime, endTime, duration: 999, transfers: 0, walkDistance: 0, legs: [] },
    alternatives: [],
    boardingWaitSeconds: 0,
    delaySeconds: 0,
  };
}
function resolved(schedules: WaypointSchedule[], wallClock = "2026-09-01T12:00") {
  return resolveScheduleConstraints({
    waypoints: schedules.map((schedule) => ({ coords: [0, 0], schedule })),
    anchor: { kind: "arriveBy", wallClock },
  });
}

describe("composeBackwardTransitSchedule", () => {
  it.each([
    { end: "2026-09-01T11:50:00Z", seconds: 3000 },
    { end: "2026-09-01T12:00:00Z", seconds: 3600 },
    { end: "2026-09-01T11:00:00Z", seconds: 0 },
  ])("preserves actual end $end and elapsed travel", ({ end, seconds }) => {
    const schedule = composeBackwardTransitSchedule({
      resolved: resolved([{ timeZone: "UTC" }, { timeZone: "UTC" }]),
      segments: [segment(0, "2026-09-01T11:00:00Z", end)],
      violations: [],
    });
    expect(schedule.arrival).toBe(end.replace("Z", "+00:00"));
    expect(schedule.legs[0].arrival).toBe(schedule.arrival);
    expect(schedule.totalTravelSeconds).toBe(seconds);
    expect(schedule.totalDwellSeconds).toBe(0);
    expect(schedule.totalWaitSeconds).toBe(0);
    expect(schedule.violations).toEqual([]);
  });

  it("accounts for dwell and waiting using actual inbound and outbound events without mutation", () => {
    const segments = [
      segment(0, "2026-09-01T09:00:00Z", "2026-09-01T10:00:00Z"),
      segment(1, "2026-09-01T10:30:00Z", "2026-09-01T11:00:00Z"),
    ];
    const before = structuredClone(segments);
    const schedule = composeBackwardTransitSchedule({
      resolved: resolved([
        { timeZone: "UTC" },
        { timeZone: "UTC", dwellSeconds: 600, departAfter: "2026-09-01T10:20" },
        { timeZone: "UTC" },
      ]),
      segments,
      violations: [],
    });
    expect(schedule.stops[1]).toMatchObject({
      arrival: "2026-09-01T10:00:00+00:00",
      departure: "2026-09-01T10:30:00+00:00",
      dwellSeconds: 600,
      waitSeconds: 1200,
    });
    expect(schedule.totalTravelSeconds).toBe(5400);
    expect(schedule.totalDwellSeconds).toBe(600);
    expect(schedule.totalWaitSeconds).toBe(1200);
    expect(Date.parse(schedule.arrival) - Date.parse(schedule.departure)).toBe(7200000);
    expect(segments).toEqual(before);
  });

  it.each([
    {
      constraint: { dwellSeconds: 600 },
      arrival: "2026-09-01T10:55:00Z",
      allowed: "11:05",
      shortfall: 300,
    },
    {
      constraint: { departAfter: "2026-09-01T11:15" },
      arrival: "2026-09-01T10:30:00Z",
      allowed: "11:15",
      shortfall: 900,
    },
    {
      constraint: { fixedAt: "2026-09-01T10:50", dwellSeconds: 1200 },
      arrival: "2026-09-01T10:40:00Z",
      allowed: "11:10",
      shortfall: 600,
    },
    { constraint: {}, arrival: "2026-09-01T11:05:00Z", allowed: "11:05", shortfall: 300 },
  ])(
    "reports unavailable departure for $constraint",
    ({ constraint, arrival, allowed, shortfall }) => {
      const schedule = composeBackwardTransitSchedule({
        resolved: resolved([
          { timeZone: "UTC" },
          { timeZone: "UTC", ...constraint },
          { timeZone: "UTC" },
        ]),
        segments: [
          segment(0, "2026-09-01T10:00:00Z", arrival),
          segment(1, "2026-09-01T11:00:00Z", "2026-09-01T11:50:00Z"),
        ],
        violations: [],
      });
      expect(schedule.violations).toContainEqual({
        kind: "early-departure",
        waypointIndex: 1,
        allowedFrom: `2026-09-01T${allowed}:00+00:00`,
        latestDeparture: "2026-09-01T11:00:00+00:00",
        shortfallSeconds: shortfall,
      });
      expect(schedule.stops.every((stop) => stop.waitSeconds >= 0)).toBe(true);
    },
  );

  it("checks intermediate arrival windows and preserves resolver diagnostics", () => {
    const constraints = resolved([
      { timeZone: "UTC" },
      { timeZone: "UTC", arriveBy: "2026-09-01T10:45" },
      { timeZone: "UTC" },
    ]);
    const violation = {
      kind: "invalid-time" as const,
      waypointIndex: 0,
      field: "departAfter",
      value: "bad",
    };
    const schedule = composeBackwardTransitSchedule({
      resolved: constraints,
      segments: [
        segment(0, "2026-09-01T10:00:00Z", "2026-09-01T10:50:00Z"),
        segment(1, "2026-09-01T11:00:00Z", "2026-09-01T11:50:00Z"),
      ],
      violations: [violation],
    });
    expect(schedule.violations).toContainEqual(violation);
    expect(schedule.violations).toContainEqual({
      kind: "late-arrival",
      waypointIndex: 1,
      requiredBy: "2026-09-01T10:45:00+00:00",
      earliestArrival: "2026-09-01T10:50:00+00:00",
      shortfallSeconds: 300,
    });
  });

  it("drops unknown inbound dwell in a suffix while enforcing its departure window", () => {
    const schedule = composeBackwardTransitSchedule({
      resolved: resolved([
        { timeZone: "UTC" },
        { timeZone: "UTC", dwellSeconds: 600, departAfter: "2026-09-01T11:15" },
        { timeZone: "UTC" },
      ]),
      segments: [segment(1, "2026-09-01T11:00:00Z", "2026-09-01T11:50:00Z")],
      violations: [{ kind: "unreachable", fromIndex: 0, toIndex: 1 }],
    });
    expect(schedule.stops.map((s) => s.waypointIndex)).toEqual([1, 2]);
    expect(schedule.stops[0]).toMatchObject({ dwellSeconds: 0, waitSeconds: 0 });
    expect(schedule.stops[0].arrival).toBeUndefined();
    expect(schedule.totalDwellSeconds).toBe(0);
    expect(schedule.violations).toContainEqual(
      expect.objectContaining({ kind: "early-departure", waypointIndex: 1, shortfallSeconds: 900 }),
    );
  });

  it.each([
    {
      start: "2026-10-25T00:30:00Z",
      end: "2026-10-25T02:30:00Z",
      zones: ["Europe/Berlin", "Europe/Berlin"],
      anchor: "2026-10-25T04:00",
      departure: "2026-10-25T02:30:00+02:00",
      arrival: "2026-10-25T03:30:00+01:00",
      offsets: [120, 60],
      multiDay: false,
    },
    {
      start: "2026-09-01T22:30:00Z",
      end: "2026-09-01T23:30:00Z",
      zones: ["UTC", "Europe/Berlin"],
      anchor: "2026-09-02T02:00",
      departure: "2026-09-01T22:30:00+00:00",
      arrival: "2026-09-02T01:30:00+02:00",
      offsets: [0, 120],
      multiDay: true,
    },
  ])(
    "formats actual instants across zones and DST: $departure",
    ({ start, end, zones, anchor, departure, arrival, offsets, multiDay }) => {
      const schedule = composeBackwardTransitSchedule({
        resolved: resolved(
          zones.map((timeZone) => ({ timeZone })),
          anchor,
        ),
        segments: [segment(0, start, end)],
        violations: [],
      });
      expect(schedule.departure).toBe(departure);
      expect(schedule.arrival).toBe(arrival);
      expect(schedule.stops.map((s) => s.utcOffsetMinutes)).toEqual(offsets);
      expect(schedule.multiDay).toBe(multiDay);
    },
  );

  it("rejects empty internal constraints", () => {
    expect(() =>
      composeBackwardTransitSchedule({ resolved: resolved([]), segments: [], violations: [] }),
    ).toThrow(/at least two stops/);
  });
});
