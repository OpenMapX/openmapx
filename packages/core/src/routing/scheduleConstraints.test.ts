import { describe, expect, it } from "vitest";
import { MAX_DWELL_SECONDS, resolveScheduleConstraints } from "./scheduleConstraints";

const COLOGNE: [number, number] = [6.96, 50.94];
const PARIS: [number, number] = [2.35, 48.86];
const NEW_YORK: [number, number] = [-74.01, 40.71];

const NOW = Date.UTC(2026, 8, 1, 6, 0);

/** Resolve a wall clock in a zone independently of the implementation. */
function at(wall: string, zone: string): number {
  const [date, time] = wall.split("T");
  const [y, mo, d] = date.split("-").map(Number);
  const [h, mi] = time.split(":").map(Number);
  const naive = Date.UTC(y, mo - 1, d, h, mi);
  const label = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "shortOffset" })
    .formatToParts(new Date(naive))
    .find((part) => part.type === "timeZoneName")?.value;
  const match = /GMT([+-])(\d{1,2})(?::?(\d{2}))?/.exec(label ?? "GMT+0");
  const offset = match
    ? (match[1] === "-" ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3] ?? 0))
    : 0;
  return naive - offset * 60_000;
}

describe("resolveScheduleConstraints", () => {
  it("resolves each waypoint's zone from its coordinate", () => {
    const result = resolveScheduleConstraints({
      waypoints: [{ coords: COLOGNE }, { coords: NEW_YORK }],
      anchor: { kind: "now" },
      nowMs: NOW,
    });
    expect(result.stops.map((stop) => stop.timeZone)).toEqual([
      "Europe/Berlin",
      "America/New_York",
    ]);
    expect(result.violations).toEqual([]);
    expect(result.anchorMs).toBe(NOW);
    expect(result.direction).toBe("forward");
  });

  it("prefers an explicit timeZone over the coordinate", () => {
    const result = resolveScheduleConstraints({
      waypoints: [
        { coords: COLOGNE, schedule: { timeZone: "Asia/Tokyo", departAfter: "2026-09-01T09:00" } },
        { coords: PARIS },
      ],
      anchor: { kind: "now" },
      nowMs: NOW,
    });
    expect(result.stops[0].timeZone).toBe("Asia/Tokyo");
    expect(result.stops[0].earliestDepartureMs).toBe(at("2026-09-01T09:00", "Asia/Tokyo"));
  });

  it("falls back to the coordinate when the explicit zone is not a real zone", () => {
    const result = resolveScheduleConstraints({
      waypoints: [{ coords: COLOGNE, schedule: { timeZone: "Not/AZone" } }, { coords: PARIS }],
      anchor: { kind: "now" },
      nowMs: NOW,
    });
    expect(result.stops[0].timeZone).toBe("Europe/Berlin");
  });

  it("anchors departAt in the origin zone and arriveBy in the destination zone", () => {
    const forward = resolveScheduleConstraints({
      waypoints: [{ coords: COLOGNE }, { coords: NEW_YORK }],
      anchor: { kind: "departAt", wallClock: "2026-09-01T09:00" },
      nowMs: NOW,
    });
    expect(forward.anchorMs).toBe(at("2026-09-01T09:00", "Europe/Berlin"));
    expect(forward.direction).toBe("forward");

    const backward = resolveScheduleConstraints({
      waypoints: [{ coords: COLOGNE }, { coords: NEW_YORK }],
      anchor: { kind: "arriveBy", wallClock: "2026-09-01T09:00" },
      nowMs: NOW,
    });
    expect(backward.anchorMs).toBe(at("2026-09-01T09:00", "America/New_York"));
    expect(backward.direction).toBe("backward");
  });

  it("keeps the trip anchor out of the stops' own constraints", () => {
    const result = resolveScheduleConstraints({
      waypoints: [{ coords: COLOGNE }, { coords: PARIS }],
      anchor: { kind: "departAt", wallClock: "2026-09-01T09:00" },
      nowMs: NOW,
    });
    // Folding it in would make an ordinary timed trip look like it carried a
    // per-waypoint window, and demand emulated semantics for nothing.
    expect(result.stops[0].earliestDepartureMs).toBeNull();
    expect(result.anchor).toEqual({ kind: "departAt", wallClock: "2026-09-01T09:00" });
  });

  it("expands fixedAt into a deadline plus an appointment-relative departure", () => {
    const result = resolveScheduleConstraints({
      waypoints: [
        { coords: COLOGNE },
        { coords: PARIS, schedule: { fixedAt: "2026-09-01T14:00", dwellSeconds: 1800 } },
        { coords: COLOGNE },
      ],
      anchor: { kind: "now" },
      nowMs: NOW,
    });
    const appointment = at("2026-09-01T14:00", "Europe/Paris");
    expect(result.stops[1].latestArrivalMs).toBe(appointment);
    expect(result.stops[1].earliestDepartureMs).toBe(appointment + 1_800_000);
    expect(result.stops[1].dwellSeconds).toBe(0);
  });

  it("accepts arriveBy together with departAfter at one stop", () => {
    const result = resolveScheduleConstraints({
      waypoints: [
        { coords: COLOGNE },
        {
          coords: PARIS,
          schedule: { arriveBy: "2026-09-01T14:00", departAfter: "2026-09-01T15:00" },
        },
        { coords: COLOGNE },
      ],
      anchor: { kind: "now" },
      nowMs: NOW,
    });
    expect(result.violations).toEqual([]);
    expect(result.stops[1].latestArrivalMs).toBe(at("2026-09-01T14:00", "Europe/Paris"));
    expect(result.stops[1].earliestDepartureMs).toBe(at("2026-09-01T15:00", "Europe/Paris"));
  });

  it("rejects fixedAt combined with another window field", () => {
    const result = resolveScheduleConstraints({
      waypoints: [
        { coords: COLOGNE },
        { coords: PARIS, schedule: { fixedAt: "2026-09-01T14:00", arriveBy: "2026-09-01T13:00" } },
        { coords: COLOGNE },
      ],
      anchor: { kind: "now" },
      nowMs: NOW,
    });
    expect(result.violations).toContainEqual({
      kind: "conflicting-fields",
      waypointIndex: 1,
      fields: ["fixedAt", "arriveBy"],
    });
  });

  it("rejects malformed and impossible wall clocks", () => {
    const result = resolveScheduleConstraints({
      waypoints: [
        { coords: COLOGNE, schedule: { departAfter: "tomorrow" } },
        { coords: PARIS, schedule: { arriveBy: "2026-02-30T10:00" } },
      ],
      anchor: { kind: "now" },
      nowMs: NOW,
    });
    expect(result.violations).toContainEqual({
      kind: "invalid-time",
      waypointIndex: 0,
      field: "departAfter",
      value: "tomorrow",
    });
    expect(result.violations).toContainEqual({
      kind: "invalid-time",
      waypointIndex: 1,
      field: "arriveBy",
      value: "2026-02-30T10:00",
    });
  });

  it("reports an unusable trip anchor against the end it pins", () => {
    const result = resolveScheduleConstraints({
      waypoints: [{ coords: COLOGNE }, { coords: PARIS }],
      anchor: { kind: "arriveBy", wallClock: "not-a-time" },
      nowMs: NOW,
    });
    expect(result.violations).toContainEqual({
      kind: "invalid-time",
      waypointIndex: 1,
      field: "arriveBy",
      value: "not-a-time",
    });
    expect(result.anchorMs).toBe(NOW);
  });

  it("rejects out-of-range and fractional dwell", () => {
    const result = resolveScheduleConstraints({
      waypoints: [
        { coords: COLOGNE },
        { coords: PARIS, schedule: { dwellSeconds: -60 } },
        { coords: PARIS, schedule: { dwellSeconds: MAX_DWELL_SECONDS + 1 } },
        { coords: PARIS, schedule: { dwellSeconds: 90.5 } },
        { coords: COLOGNE },
      ],
      anchor: { kind: "now" },
      nowMs: NOW,
    });
    expect(
      result.violations.filter((violation) => violation.kind === "invalid-dwell"),
    ).toHaveLength(3);
    expect(result.stops[1].dwellSeconds).toBe(0);
  });

  it("keeps zero dwell and drops dwell at the endpoints", () => {
    const result = resolveScheduleConstraints({
      waypoints: [
        { coords: COLOGNE, schedule: { dwellSeconds: 600 } },
        { coords: PARIS, schedule: { dwellSeconds: 0 } },
        { coords: COLOGNE, schedule: { dwellSeconds: 600 } },
      ],
      anchor: { kind: "now" },
      nowMs: NOW,
    });
    expect(result.stops.map((stop) => stop.dwellSeconds)).toEqual([0, 0, 0]);
    expect(result.stops.map((stop) => stop.dwellIgnored)).toEqual([true, false, true]);
    expect(result.violations).toEqual([]);
  });

  it("reports inverted order across two waypoints, counting dwell in between", () => {
    const result = resolveScheduleConstraints({
      waypoints: [
        { coords: COLOGNE, schedule: { departAfter: "2026-09-01T12:00" } },
        { coords: PARIS, schedule: { dwellSeconds: 3600 } },
        { coords: PARIS, schedule: { arriveBy: "2026-09-01T12:30" } },
      ],
      anchor: { kind: "now" },
      nowMs: NOW,
    });
    expect(result.violations).toContainEqual(
      expect.objectContaining({ kind: "inverted-order", fromIndex: 0, toIndex: 2 }),
    );
  });

  it("reports an anchor conflict rather than inverted order when the anchor binds", () => {
    const result = resolveScheduleConstraints({
      waypoints: [
        { coords: COLOGNE },
        { coords: PARIS, schedule: { arriveBy: "2026-09-01T08:00" } },
        { coords: COLOGNE },
      ],
      anchor: { kind: "departAt", wallClock: "2026-09-01T09:00" },
      nowMs: NOW,
    });
    expect(result.violations).toContainEqual(
      expect.objectContaining({ kind: "anchor-conflict", waypointIndex: 1 }),
    );
    expect(result.violations.some((violation) => violation.kind === "inverted-order")).toBe(false);
  });

  it("reports an arrive-by anchor that a stop's own departure window cannot meet", () => {
    const result = resolveScheduleConstraints({
      waypoints: [
        { coords: COLOGNE, schedule: { departAfter: "2026-09-01T20:00" } },
        { coords: PARIS },
      ],
      anchor: { kind: "arriveBy", wallClock: "2026-09-01T18:00" },
      nowMs: NOW,
    });
    expect(result.violations).toContainEqual(
      expect.objectContaining({ kind: "inverted-order", fromIndex: 0, toIndex: 1 }),
    );
  });

  it("resolves a wall clock inside the European spring-forward gap to the first valid instant", () => {
    const result = resolveScheduleConstraints({
      waypoints: [
        { coords: COLOGNE, schedule: { departAfter: "2027-03-28T02:30" } },
        { coords: PARIS },
      ],
      anchor: { kind: "now" },
      nowMs: NOW,
    });
    expect(result.stops[0].earliestDepartureMs).toBe(Date.UTC(2027, 2, 28, 1, 0));
    expect(result.violations).toEqual([]);
  });

  it("resolves an ambiguous autumn wall clock to the earlier instant", () => {
    const result = resolveScheduleConstraints({
      waypoints: [
        { coords: COLOGNE, schedule: { departAfter: "2026-10-25T02:30" } },
        { coords: PARIS },
      ],
      anchor: { kind: "now" },
      nowMs: NOW,
    });
    expect(result.stops[0].earliestDepartureMs).toBe(Date.UTC(2026, 9, 25, 0, 30));
  });
});
