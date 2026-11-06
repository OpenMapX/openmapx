import type { TripLeg, VehicleJourneyStop } from "@openmapx/mobility-core/transit";
import { describe, expect, it } from "vitest";
import { legTransitTime, stopTransitTime, transitDelayMinutes } from "./transitTime";

const time = (clock: string) => `2026-11-06T${clock}Z`;
describe("transit time evidence", () => {
  it.each([
    ["08:44:00", "08:45:00", 1],
    ["08:44:50", "08:45:10", 1],
    ["08:44:10", "08:44:50", 0],
    ["08:44:00", "08:43:00", -1],
    ["08:44:00", "08:44:00", 0],
  ] as const)("compares displayed minutes %s → %s", (scheduled, expected, minutes) => {
    expect(transitDelayMinutes({ scheduledAt: time(scheduled), expectedAt: time(expected) })).toBe(
      minutes,
    );
  });
  it("calculates a one-minute delay across midnight", () => {
    expect(
      transitDelayMinutes({ scheduledAt: time("23:59:30"), expectedAt: "2026-11-07T00:00:10Z" }),
    ).toBe(1);
  });
  it.each([
    { scheduledAt: time("08:44:00") },
    { expectedAt: time("08:45:00") },
    { scheduledAt: "invalid", expectedAt: time("08:45:00") },
    { scheduledAt: time("08:44:00"), expectedAt: "invalid" },
  ])("does not invent a delay without a valid timestamp pair", (input) => {
    expect(transitDelayMinutes(input)).toBeUndefined();
  });
  it("derives captured stop delays without numeric delaySeconds", () => {
    const stop = { scheduledDeparture: time("08:44:00"), expectedDeparture: time("08:45:00") };
    const value = stopTransitTime(stop);
    expect(value).toEqual({ scheduledAt: time("08:44:00"), expectedAt: time("08:45:00") });
    expect(transitDelayMinutes(value)).toBe(1);
  });
  it("does not turn a numeric hint into an expected timestamp", () => {
    const stop = { scheduledDeparture: time("08:44:00"), delaySeconds: 60 } as VehicleJourneyStop;
    expect(stopTransitTime(stop)).toEqual({ scheduledAt: time("08:44:00") });
  });
  it("uses departure evidence rather than confusing an arrival delay with dwell time", () => {
    const stop = {
      scheduledArrival: time("08:43:00"),
      expectedArrival: time("08:44:00"),
      scheduledDeparture: time("08:45:00"),
      expectedDeparture: time("08:45:00"),
    };
    expect(transitDelayMinutes(stopTransitTime(stop))).toBe(0);
    expect(transitDelayMinutes(stopTransitTime(stop, "arrival"))).toBe(1);
  });
  it("does not pair an arrival prediction with a scheduled departure", () => {
    expect(
      stopTransitTime({ scheduledDeparture: time("08:45:00"), expectedArrival: time("08:44:00") }),
    ).toEqual({ scheduledAt: time("08:45:00") });
  });
  it("falls back to the arrival pair when a stop has no departure", () => {
    expect(
      stopTransitTime({ scheduledArrival: time("08:52:00"), expectedArrival: time("08:53:00") }),
    ).toEqual({ scheduledAt: time("08:52:00"), expectedAt: time("08:53:00") });
  });
  it("keeps navigation endpoint clocks anchored to the selected itinerary", () => {
    const leg = {
      startTime: time("08:45:00"),
      scheduledStartTime: time("08:44:00"),
      endTime: time("08:53:00"),
      scheduledEndTime: time("08:52:00"),
      realtime: true,
    } as TripLeg;
    const capture = {
      scheduledDeparture: time("08:44:00"),
      expectedDeparture: time("08:46:00"),
      scheduledArrival: time("08:52:00"),
      expectedArrival: time("08:54:00"),
    };
    expect(legTransitTime(leg, "departure", capture)).toEqual({
      scheduledAt: time("08:44:00"),
      expectedAt: time("08:45:00"),
    });
    expect(legTransitTime(leg, "arrival", capture)).toEqual({
      scheduledAt: time("08:52:00"),
      expectedAt: time("08:53:00"),
    });
  });
  it("uses captured time evidence only if the itinerary endpoint is invalid", () => {
    expect(
      legTransitTime({ startTime: "invalid" } as TripLeg, "departure", {
        scheduledDeparture: time("08:44:00"),
        expectedDeparture: time("08:45:00"),
      }),
    ).toEqual({ scheduledAt: time("08:44:00"), expectedAt: time("08:45:00") });
  });
  it("does not substitute a capture's timetable when the leg has no scheduled baseline", () => {
    expect(
      legTransitTime({ startTime: time("08:45:00"), realtime: true } as TripLeg, "departure", {
        scheduledDeparture: time("08:44:00"),
      }),
    ).toEqual({ expectedAt: time("08:45:00") });
  });
});
