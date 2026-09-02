import { describe, expect, it } from "vitest";
import {
  createScheduleCacheIdentity,
  MAX_SCHEDULE_WAYPOINTS,
  parseScheduleRequest,
  ScheduleRequestValidationError,
} from "../schedule-request.js";

const COLOGNE: [number, number] = [6.96, 50.94];
const PARIS: [number, number] = [2.35, 48.86];

describe("parseScheduleRequest", () => {
  it("parses a minimal body", () => {
    const parsed = parseScheduleRequest({ waypoints: [COLOGNE, PARIS] });
    expect(parsed.waypoints).toEqual([COLOGNE, PARIS]);
    expect(parsed.travelMode).toBe("driving");
    expect(parsed.anchor).toEqual({ kind: "now" });
    expect(parsed.hasWindows).toBe(false);
  });

  it("rejects fewer than two waypoints", () => {
    expect(() => parseScheduleRequest({ waypoints: [COLOGNE] })).toThrow(
      ScheduleRequestValidationError,
    );
  });

  it("rejects more waypoints than the chained path can serve", () => {
    const many = Array.from({ length: MAX_SCHEDULE_WAYPOINTS + 1 }, () => COLOGNE);
    expect(() => parseScheduleRequest({ waypoints: many })).toThrow(/2-25/);
  });

  it("rejects a schedules array that does not align with the waypoints", () => {
    expect(() => parseScheduleRequest({ waypoints: [COLOGNE, PARIS], schedules: [null] })).toThrow(
      /schedules must have one entry per waypoint/,
    );
  });

  it("rejects departAt together with arriveBy", () => {
    expect(() =>
      parseScheduleRequest({
        waypoints: [COLOGNE, PARIS],
        departAt: "2026-09-01T09:00",
        arriveBy: "2026-09-01T17:00",
      }),
    ).toThrow(/mutually exclusive/);
  });

  it("rejects transit mode", () => {
    expect(() => parseScheduleRequest({ waypoints: [COLOGNE, PARIS], mode: "transit" })).toThrow(
      /transit/i,
    );
  });

  it("rejects an unknown key inside a waypoint schedule", () => {
    expect(() =>
      parseScheduleRequest({
        waypoints: [COLOGNE, PARIS],
        schedules: [null, { leaveWhenever: true }],
      }),
    ).toThrow(/unknown schedule field/);
  });

  it("rejects an out-of-range dwell", () => {
    expect(() =>
      parseScheduleRequest({
        waypoints: [COLOGNE, PARIS],
        schedules: [null, { dwellSeconds: 100_000 }],
      }),
    ).toThrow(/dwellSeconds must be between/);
  });

  it("flags windows so the planner can pick its path", () => {
    const dwellOnly = parseScheduleRequest({
      waypoints: [COLOGNE, PARIS, COLOGNE],
      schedules: [null, { dwellSeconds: 600 }, null],
    });
    expect(dwellOnly.hasWindows).toBe(false);

    const windowed = parseScheduleRequest({
      waypoints: [COLOGNE, PARIS, COLOGNE],
      schedules: [null, { arriveBy: "2026-09-01T14:00" }, null],
    });
    expect(windowed.hasWindows).toBe(true);
  });

  it("rejects optimize on a windowed trip and allows it on a dwell-only trip", () => {
    expect(() =>
      parseScheduleRequest({
        waypoints: [COLOGNE, PARIS, COLOGNE],
        schedules: [null, { fixedAt: "2026-09-01T14:00" }, null],
        optimize: true,
      }),
    ).toThrow(/optimized while/);

    expect(
      parseScheduleRequest({
        waypoints: [COLOGNE, PARIS, COLOGNE],
        schedules: [null, { dwellSeconds: 600 }, null],
        optimize: true,
      }).optimize,
    ).toBe(true);
  });

  it("carries the machine reason on the optimize rejection", () => {
    try {
      parseScheduleRequest({
        waypoints: [COLOGNE, PARIS, COLOGNE],
        schedules: [null, { fixedAt: "2026-09-01T14:00" }, null],
        optimize: true,
      });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as ScheduleRequestValidationError).reason).toBe(
        "window-constraints-not-optimizable",
      );
    }
  });
});

describe("createScheduleCacheIdentity", () => {
  const base = {
    waypoints: [COLOGNE, PARIS] as [number, number][],
    schedules: [null, { arriveBy: "2026-09-01T14:00", timeZone: "Europe/Paris" }],
  };

  it("is stable for identical inputs", () => {
    const a = createScheduleCacheIdentity(parseScheduleRequest(base), null);
    const b = createScheduleCacheIdentity(parseScheduleRequest(base), null);
    expect(a).toEqual(b);
  });

  it("changes when a schedule field changes", () => {
    const a = createScheduleCacheIdentity(parseScheduleRequest(base), null);
    const b = createScheduleCacheIdentity(
      parseScheduleRequest({
        ...base,
        schedules: [null, { arriveBy: "2026-09-01T14:30", timeZone: "Europe/Paris" }],
      }),
      null,
    );
    expect(a).not.toEqual(b);
  });

  it("changes when only the resolved time zone changes", () => {
    const a = createScheduleCacheIdentity(parseScheduleRequest(base), null);
    const b = createScheduleCacheIdentity(
      parseScheduleRequest({
        ...base,
        schedules: [null, { arriveBy: "2026-09-01T14:00", timeZone: "Europe/Lisbon" }],
      }),
      null,
    );
    expect(a).not.toEqual(b);
  });

  it("changes when the anchor direction changes", () => {
    const departing = createScheduleCacheIdentity(
      parseScheduleRequest({ ...base, departAt: "2026-09-01T09:00" }),
      null,
    );
    const arriving = createScheduleCacheIdentity(
      parseScheduleRequest({ ...base, arriveBy: "2026-09-01T09:00" }),
      null,
    );
    expect(departing).not.toEqual(arriving);
  });

  it("does not drift with the wall clock", () => {
    const first = createScheduleCacheIdentity(
      parseScheduleRequest({ waypoints: [COLOGNE, PARIS] }),
      null,
    );
    const second = createScheduleCacheIdentity(
      parseScheduleRequest({ waypoints: [COLOGNE, PARIS] }),
      null,
    );
    expect(first).toEqual(second);
  });
});
