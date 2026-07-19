import { describe, expect, it } from "vitest";
import { legArrivalDelaySeconds, legDepartureDelaySeconds } from "./transit-delay.js";

describe("legArrivalDelaySeconds", () => {
  it("returns the signed difference between realtime and scheduled arrival", () => {
    expect(
      legArrivalDelaySeconds({
        endTime: "2026-07-15T10:19:00Z",
        scheduledEndTime: "2026-07-15T10:15:00Z",
      }),
    ).toBe(240);
  });

  it("is negative when arriving early", () => {
    expect(
      legArrivalDelaySeconds({
        endTime: "2026-07-15T10:13:30Z",
        scheduledEndTime: "2026-07-15T10:15:00Z",
      }),
    ).toBe(-90);
  });

  it("is undefined when a timestamp is missing", () => {
    expect(legArrivalDelaySeconds({ endTime: "2026-07-15T10:19:00Z" })).toBeUndefined();
    expect(legArrivalDelaySeconds({ scheduledEndTime: "2026-07-15T10:15:00Z" })).toBeUndefined();
  });

  it("is undefined for unparseable timestamps", () => {
    expect(
      legArrivalDelaySeconds({ endTime: "not-a-date", scheduledEndTime: "2026-07-15T10:15:00Z" }),
    ).toBeUndefined();
  });
});

describe("legDepartureDelaySeconds", () => {
  it("returns the signed difference between realtime and scheduled departure", () => {
    expect(
      legDepartureDelaySeconds({
        startTime: "2026-07-15T10:04:00Z",
        scheduledStartTime: "2026-07-15T10:00:00Z",
      }),
    ).toBe(240);
  });
});
