import { describe, expect, it } from "vitest";
import { liveArrivalDelayMs, transitRemainingSeconds } from "./TransitNavBottomBar";

describe("transitRemainingSeconds", () => {
  const arrivalMs = new Date("2026-06-18T12:00:00.000Z").getTime();

  it("counts down as wall-clock time advances toward arrival", () => {
    const tenMinBefore = transitRemainingSeconds(arrivalMs, arrivalMs - 10 * 60_000);
    const fiveMinBefore = transitRemainingSeconds(arrivalMs, arrivalMs - 5 * 60_000);
    expect(tenMinBefore).toBe(600);
    expect(fiveMinBefore).toBe(300);
    // Progressing (later `now`) yields a smaller remaining — i.e. it counts down.
    expect(fiveMinBefore < tenMinBefore).toBe(true);
  });

  it("clamps to zero at and past arrival", () => {
    expect(transitRemainingSeconds(arrivalMs, arrivalMs)).toBe(0);
    expect(transitRemainingSeconds(arrivalMs, arrivalMs + 60_000)).toBe(0);
  });

  it("returns zero for an unparseable arrival time", () => {
    expect(transitRemainingSeconds(Number.NaN, arrivalMs)).toBe(0);
  });
});

describe("liveArrivalDelayMs", () => {
  const plannedEnd = "2026-06-18T12:00:00.000Z";
  const plannedMs = new Date(plannedEnd).getTime();
  const alight = "stop-B";
  const stops = (expected: string | undefined, extra: Record<string, unknown> = {}) => [
    { stopId: "stop-A", expectedArrival: "2026-06-18T11:50:00.000Z" },
    { stopId: alight, expectedArrival: expected, ...extra },
  ];

  it("returns the positive delay when the bus runs late vs the plan", () => {
    // expectedArrival 8 min after the planned leg end.
    const stopsLate = stops(new Date(plannedMs + 8 * 60_000).toISOString());
    expect(liveArrivalDelayMs(stopsLate, alight, plannedEnd)).toBe(8 * 60_000);
  });

  it("returns a negative delay when the bus is ahead of the plan", () => {
    const stopsEarly = stops(new Date(plannedMs - 2 * 60_000).toISOString());
    expect(liveArrivalDelayMs(stopsEarly, alight, plannedEnd)).toBe(-2 * 60_000);
  });

  it("falls back to scheduledArrival + delaySeconds when expectedArrival is absent", () => {
    const stopsNoExpected = [
      {
        stopId: alight,
        expectedArrival: undefined,
        scheduledArrival: plannedEnd,
        delaySeconds: 180,
      },
    ];
    expect(liveArrivalDelayMs(stopsNoExpected, alight, plannedEnd)).toBe(180 * 1000);
  });

  it("returns 0 when there is no live data, no matching stop, or no leg", () => {
    expect(liveArrivalDelayMs(undefined, alight, plannedEnd)).toBe(0);
    expect(liveArrivalDelayMs(stops("2026-06-18T12:05:00.000Z"), "missing", plannedEnd)).toBe(0);
    expect(liveArrivalDelayMs(stops("2026-06-18T12:05:00.000Z"), undefined, plannedEnd)).toBe(0);
    expect(liveArrivalDelayMs(stops("2026-06-18T12:05:00.000Z"), alight, undefined)).toBe(0);
  });

  it("returns 0 when the alight stop has no realtime fields", () => {
    expect(liveArrivalDelayMs([{ stopId: alight }], alight, plannedEnd)).toBe(0);
  });
});
