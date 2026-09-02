import { describe, expect, it } from "vitest";
import type { ResolvedSchedule, ResolvedStopConstraint } from "./scheduleConstraints";
import { planScheduledTrip, UnsupportedScheduleDirectionError } from "./scheduledTrip";

const BERLIN = "Europe/Berlin";
const HOUR = 3_600;
/** 2026-09-01T09:00 in Europe/Berlin. */
const NINE_AM = Date.UTC(2026, 8, 1, 7, 0);

function stop(
  index: number,
  overrides: Partial<ResolvedStopConstraint> = {},
): ResolvedStopConstraint {
  return {
    index,
    timeZone: BERLIN,
    earliestDepartureMs: null,
    latestArrivalMs: null,
    dwellSeconds: 0,
    dwellIgnored: false,
    ...overrides,
  };
}

function resolved(
  stops: ResolvedStopConstraint[],
  overrides: Partial<ResolvedSchedule> = {},
): ResolvedSchedule {
  return {
    stops,
    anchorMs: NINE_AM,
    anchor: { kind: "now" },
    direction: "forward",
    violations: [],
    ...overrides,
  };
}

describe("planScheduledTrip forward", () => {
  it("calls the oracle once per leg with the computed departure instant", async () => {
    const calls: [number, number][] = [];
    const result = await planScheduledTrip({
      resolved: resolved([stop(0), stop(1, { dwellSeconds: 1800 }), stop(2)]),
      forward: async (legIndex, departureMs) => {
        calls.push([legIndex, departureMs]);
        return { seconds: HOUR, payload: `leg-${legIndex}` };
      },
    });
    expect(calls).toEqual([
      [0, NINE_AM],
      [1, NINE_AM + 3_600_000 + 1_800_000],
    ]);
    expect(result.legPayloads).toEqual(["leg-0", "leg-1"]);
    expect(result.schedule.arrival).toBe("2026-09-01T11:30:00+02:00");
  });

  it("waits at a stop whose earliest departure binds, and asks for the later hour", async () => {
    const calls: number[] = [];
    await planScheduledTrip({
      resolved: resolved([
        stop(0),
        stop(1, { earliestDepartureMs: Date.UTC(2026, 8, 1, 12, 0) }),
        stop(2),
      ]),
      forward: async (_legIndex, departureMs) => {
        calls.push(departureMs);
        return { seconds: HOUR };
      },
    });
    expect(calls).toEqual([NINE_AM, Date.UTC(2026, 8, 1, 12, 0)]);
  });

  it("carries the resolver's own violations through to the schedule", async () => {
    const result = await planScheduledTrip({
      resolved: resolved([stop(0), stop(1)], {
        violations: [{ kind: "invalid-dwell", waypointIndex: 1, dwellSeconds: -1 }],
      }),
      forward: async () => ({ seconds: HOUR }),
    });
    expect(result.schedule.violations).toContainEqual({
      kind: "invalid-dwell",
      waypointIndex: 1,
      dwellSeconds: -1,
    });
  });

  it("stops at a failing leg and reports it as unreachable", async () => {
    const result = await planScheduledTrip({
      resolved: resolved([stop(0), stop(1), stop(2)]),
      forward: async (legIndex) => {
        if (legIndex === 1) throw new Error("no route");
        return { seconds: HOUR, payload: legIndex };
      },
    });
    expect(result.schedule.violations).toContainEqual({
      kind: "unreachable",
      fromIndex: 1,
      toIndex: 2,
    });
    expect(result.legPayloads).toEqual([0]);
    expect(result.schedule.legs).toHaveLength(1);
    expect(result.schedule.arrival).toBe("2026-09-01T10:00:00+02:00");
  });

  it("rejects a forward solve with no forward oracle", async () => {
    await expect(
      planScheduledTrip({ resolved: resolved([stop(0), stop(1)]), providerId: "osrm" }),
    ).rejects.toBeInstanceOf(UnsupportedScheduleDirectionError);
  });
});

describe("planScheduledTrip backward", () => {
  it("walks legs from the deadline backwards", async () => {
    const calls: [number, number][] = [];
    const deadline = Date.UTC(2026, 8, 1, 16, 0);
    const result = await planScheduledTrip({
      resolved: resolved([stop(0), stop(1, { dwellSeconds: 1800 }), stop(2)], {
        direction: "backward",
        anchor: { kind: "arriveBy", wallClock: "2026-09-01T18:00" },
        anchorMs: deadline,
      }),
      backward: async (legIndex, arrivalMs) => {
        calls.push([legIndex, arrivalMs]);
        return { seconds: HOUR, payload: `leg-${legIndex}` };
      },
    });
    expect(calls).toEqual([
      [1, deadline],
      [0, deadline - 3_600_000 - 1_800_000],
    ]);
    // Payloads stay in leg order regardless of the walk direction.
    expect(result.legPayloads).toEqual(["leg-0", "leg-1"]);
    expect(result.schedule.departure).toBe("2026-09-01T15:30:00+02:00");
  });

  it("keeps the suffix and reports violations against the original waypoint index", async () => {
    const deadline = Date.UTC(2026, 8, 1, 16, 0);
    const result = await planScheduledTrip({
      resolved: resolved(
        [stop(0), stop(1), stop(2, { earliestDepartureMs: Date.UTC(2026, 8, 1, 20, 0) }), stop(3)],
        {
          direction: "backward",
          anchor: { kind: "arriveBy", wallClock: "2026-09-01T18:00" },
          anchorMs: deadline,
        },
      ),
      backward: async (legIndex) => {
        if (legIndex === 0) throw new Error("no route");
        return { seconds: HOUR };
      },
    });
    expect(result.schedule.violations).toContainEqual({
      kind: "unreachable",
      fromIndex: 0,
      toIndex: 1,
    });
    expect(result.schedule.stops.map((entry) => entry.waypointIndex)).toEqual([1, 2, 3]);
    expect(result.schedule.violations).toContainEqual(
      expect.objectContaining({ kind: "early-departure", waypointIndex: 2 }),
    );
  });

  it("rejects a backward solve with no backward oracle", async () => {
    await expect(
      planScheduledTrip({
        resolved: resolved([stop(0), stop(1)], {
          direction: "backward",
          anchor: { kind: "arriveBy", wallClock: "2026-09-01T18:00" },
        }),
        forward: async () => ({ seconds: HOUR }),
        providerId: "osrm",
      }),
    ).rejects.toMatchObject({ code: "backward-solve-unsupported", providerId: "osrm" });
  });
});
