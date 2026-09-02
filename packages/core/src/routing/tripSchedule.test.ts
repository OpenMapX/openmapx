import { describe, expect, it } from "vitest";
import type { ResolvedStopConstraint } from "./scheduleConstraints";
import { arrivalBefore, composeSchedule, departureAfter } from "./tripSchedule";

const BERLIN = "Europe/Berlin";
const NEW_YORK = "America/New_York";

function stop(
  overrides: Partial<ResolvedStopConstraint> & { index: number },
): ResolvedStopConstraint {
  return {
    timeZone: BERLIN,
    earliestDepartureMs: null,
    latestArrivalMs: null,
    dwellSeconds: 0,
    dwellIgnored: false,
    ...overrides,
  };
}

/** 2026-09-01T09:00 in Europe/Berlin (CEST, UTC+2). */
const NINE_AM_BERLIN = Date.UTC(2026, 8, 1, 7, 0);
const HOUR = 3_600;

describe("departureAfter / arrivalBefore", () => {
  it("adds dwell and respects a binding earliest departure", () => {
    const binding = stop({
      index: 1,
      dwellSeconds: 600,
      earliestDepartureMs: NINE_AM_BERLIN + 3_600_000,
    });
    expect(departureAfter(binding, NINE_AM_BERLIN)).toBe(NINE_AM_BERLIN + 3_600_000);
    expect(departureAfter(stop({ index: 1, dwellSeconds: 600 }), NINE_AM_BERLIN)).toBe(
      NINE_AM_BERLIN + 600_000,
    );
  });

  it("subtracts dwell and respects a binding latest arrival", () => {
    const binding = stop({
      index: 1,
      dwellSeconds: 600,
      latestArrivalMs: NINE_AM_BERLIN - 3_600_000,
    });
    expect(arrivalBefore(binding, NINE_AM_BERLIN)).toBe(NINE_AM_BERLIN - 3_600_000);
    expect(arrivalBefore(stop({ index: 1, dwellSeconds: 600 }), NINE_AM_BERLIN)).toBe(
      NINE_AM_BERLIN - 600_000,
    );
  });
});

describe("composeSchedule forward", () => {
  it("chains legs and dwell into arrival and departure times", () => {
    const schedule = composeSchedule({
      stops: [stop({ index: 0 }), stop({ index: 1, dwellSeconds: 1800 }), stop({ index: 2 })],
      legSeconds: [HOUR, 2 * HOUR],
      anchorMs: NINE_AM_BERLIN,
      direction: "forward",
    });
    expect(schedule.departure).toBe("2026-09-01T09:00:00+02:00");
    expect(schedule.stops[1].arrival).toBe("2026-09-01T10:00:00+02:00");
    expect(schedule.stops[1].departure).toBe("2026-09-01T10:30:00+02:00");
    expect(schedule.arrival).toBe("2026-09-01T12:30:00+02:00");
    expect(schedule.totalTravelSeconds).toBe(3 * HOUR);
    expect(schedule.totalDwellSeconds).toBe(1800);
    expect(schedule.totalWaitSeconds).toBe(0);
    expect(schedule.violations).toEqual([]);
    expect(schedule.multiDay).toBe(false);
  });

  it("aligns legs with the waypoints they connect", () => {
    const schedule = composeSchedule({
      stops: [stop({ index: 0 }), stop({ index: 1 }), stop({ index: 2 })],
      legSeconds: [HOUR, HOUR],
      anchorMs: NINE_AM_BERLIN,
      direction: "forward",
    });
    expect(schedule.legs).toEqual([
      {
        fromIndex: 0,
        toIndex: 1,
        departure: "2026-09-01T09:00:00+02:00",
        arrival: "2026-09-01T10:00:00+02:00",
        travelSeconds: HOUR,
      },
      {
        fromIndex: 1,
        toIndex: 2,
        departure: "2026-09-01T10:00:00+02:00",
        arrival: "2026-09-01T11:00:00+02:00",
        travelSeconds: HOUR,
      },
    ]);
  });

  it("treats zero dwell exactly like no dwell", () => {
    const withZero = composeSchedule({
      stops: [stop({ index: 0 }), stop({ index: 1, dwellSeconds: 0 }), stop({ index: 2 })],
      legSeconds: [HOUR, HOUR],
      anchorMs: NINE_AM_BERLIN,
      direction: "forward",
    });
    const without = composeSchedule({
      stops: [stop({ index: 0 }), stop({ index: 1 }), stop({ index: 2 })],
      legSeconds: [HOUR, HOUR],
      anchorMs: NINE_AM_BERLIN,
      direction: "forward",
    });
    expect(withZero.arrival).toBe(without.arrival);
    expect(withZero.totalDwellSeconds).toBe(0);
  });

  it("records wait when an earliest departure binds", () => {
    const schedule = composeSchedule({
      stops: [
        stop({ index: 0 }),
        stop({ index: 1, dwellSeconds: 600, earliestDepartureMs: NINE_AM_BERLIN + 3 * 3_600_000 }),
        stop({ index: 2 }),
      ],
      legSeconds: [HOUR, HOUR],
      anchorMs: NINE_AM_BERLIN,
      direction: "forward",
    });
    expect(schedule.stops[1].arrival).toBe("2026-09-01T10:00:00+02:00");
    expect(schedule.stops[1].departure).toBe("2026-09-01T12:00:00+02:00");
    expect(schedule.stops[1].waitSeconds).toBe(2 * HOUR - 600);
    expect(schedule.totalWaitSeconds).toBe(2 * HOUR - 600);
  });

  it("reports a missed deadline with the exact shortfall and keeps the schedule", () => {
    const schedule = composeSchedule({
      stops: [
        stop({ index: 0 }),
        stop({ index: 1, latestArrivalMs: NINE_AM_BERLIN + 30 * 60_000 }),
        stop({ index: 2 }),
      ],
      legSeconds: [HOUR, HOUR],
      anchorMs: NINE_AM_BERLIN,
      direction: "forward",
    });
    expect(schedule.violations).toEqual([
      {
        kind: "late-arrival",
        waypointIndex: 1,
        requiredBy: "2026-09-01T09:30:00+02:00",
        earliestArrival: "2026-09-01T10:00:00+02:00",
        shortfallSeconds: 1800,
      },
    ]);
    expect(schedule.arrival).toBe("2026-09-01T11:00:00+02:00");
  });

  it("renders each stop in its own zone across a boundary", () => {
    const schedule = composeSchedule({
      stops: [stop({ index: 0 }), stop({ index: 1, timeZone: NEW_YORK })],
      legSeconds: [8 * HOUR],
      anchorMs: NINE_AM_BERLIN,
      direction: "forward",
    });
    expect(schedule.stops[0].departure).toBe("2026-09-01T09:00:00+02:00");
    expect(schedule.stops[0].utcOffsetMinutes).toBe(120);
    expect(schedule.stops[1].arrival).toBe("2026-09-01T11:00:00-04:00");
    expect(schedule.stops[1].utcOffsetMinutes).toBe(-240);
  });

  it("flags a trip that crosses midnight into the next local day", () => {
    const lateEvening = Date.UTC(2026, 8, 1, 20, 0);
    const schedule = composeSchedule({
      stops: [stop({ index: 0 }), stop({ index: 1 })],
      legSeconds: [4 * HOUR],
      anchorMs: lateEvening,
      direction: "forward",
    });
    expect(schedule.departure).toBe("2026-09-01T22:00:00+02:00");
    expect(schedule.arrival).toBe("2026-09-02T02:00:00+02:00");
    expect(schedule.multiDay).toBe(true);
  });

  it("keeps elapsed time honest across a DST fall-back", () => {
    const beforeTransition = Date.UTC(2026, 9, 24, 23, 0);
    const schedule = composeSchedule({
      stops: [stop({ index: 0 }), stop({ index: 1 })],
      legSeconds: [2 * HOUR],
      anchorMs: beforeTransition,
      direction: "forward",
    });
    expect(schedule.departure).toBe("2026-10-25T01:00:00+02:00");
    expect(schedule.arrival).toBe("2026-10-25T02:00:00+01:00");
  });

  it("spans several days and totals correctly", () => {
    const schedule = composeSchedule({
      stops: [
        stop({ index: 0 }),
        stop({ index: 1, dwellSeconds: 12 * HOUR }),
        stop({ index: 2, dwellSeconds: 12 * HOUR }),
        stop({ index: 3 }),
      ],
      legSeconds: [6 * HOUR, 6 * HOUR, 6 * HOUR],
      anchorMs: NINE_AM_BERLIN,
      direction: "forward",
    });
    expect(schedule.multiDay).toBe(true);
    expect(schedule.totalTravelSeconds).toBe(18 * HOUR);
    expect(schedule.totalDwellSeconds).toBe(24 * HOUR);
    // 09:00 day 1 plus 18 h travel and 24 h dwell lands at 03:00 on day 3.
    expect(schedule.stops[2].departure).toBe("2026-09-02T21:00:00+02:00");
    expect(schedule.arrival).toBe("2026-09-03T03:00:00+02:00");
  });

  it("renders a degenerate single-stop schedule from the anchor", () => {
    const schedule = composeSchedule({
      stops: [stop({ index: 0 })],
      legSeconds: [],
      anchorMs: NINE_AM_BERLIN,
      direction: "forward",
    });
    expect(schedule.departure).toBe("2026-09-01T09:00:00+02:00");
    expect(schedule.arrival).toBe("2026-09-01T09:00:00+02:00");
  });
});

describe("composeSchedule backward", () => {
  it("works back from the deadline", () => {
    const deadline = Date.UTC(2026, 8, 1, 16, 0);
    const schedule = composeSchedule({
      stops: [stop({ index: 0 }), stop({ index: 1, dwellSeconds: 1800 }), stop({ index: 2 })],
      legSeconds: [HOUR, 2 * HOUR],
      anchorMs: deadline,
      direction: "backward",
    });
    expect(schedule.arrival).toBe("2026-09-01T18:00:00+02:00");
    expect(schedule.stops[1].departure).toBe("2026-09-01T16:00:00+02:00");
    expect(schedule.stops[1].arrival).toBe("2026-09-01T15:30:00+02:00");
    expect(schedule.departure).toBe("2026-09-01T14:30:00+02:00");
    expect(schedule.violations).toEqual([]);
  });

  it("turns a binding intermediate deadline into wait, not a violation", () => {
    const deadline = Date.UTC(2026, 8, 1, 16, 0);
    const schedule = composeSchedule({
      stops: [
        stop({ index: 0 }),
        stop({ index: 1, latestArrivalMs: Date.UTC(2026, 8, 1, 12, 0) }),
        stop({ index: 2 }),
      ],
      legSeconds: [HOUR, 2 * HOUR],
      anchorMs: deadline,
      direction: "backward",
    });
    expect(schedule.stops[1].arrival).toBe("2026-09-01T14:00:00+02:00");
    expect(schedule.stops[1].departure).toBe("2026-09-01T16:00:00+02:00");
    expect(schedule.stops[1].waitSeconds).toBe(2 * HOUR);
    expect(schedule.violations).toEqual([]);
  });

  it("reports early-departure when the backward walk outruns an earliest departure", () => {
    const deadline = Date.UTC(2026, 8, 1, 10, 0);
    const schedule = composeSchedule({
      stops: [
        stop({ index: 0, earliestDepartureMs: Date.UTC(2026, 8, 1, 9, 0) }),
        stop({ index: 1 }),
      ],
      legSeconds: [2 * HOUR],
      anchorMs: deadline,
      direction: "backward",
    });
    expect(schedule.violations).toEqual([
      {
        kind: "early-departure",
        waypointIndex: 0,
        allowedFrom: "2026-09-01T11:00:00+02:00",
        latestDeparture: "2026-09-01T10:00:00+02:00",
        shortfallSeconds: HOUR,
      },
    ]);
  });
});
