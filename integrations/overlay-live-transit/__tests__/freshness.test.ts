import { describe, expect, it } from "vitest";
import { isFreshVehicleObservation } from "../freshness.js";

describe("isFreshVehicleObservation", () => {
  const now = new Date("2026-07-15T12:00:00Z").getTime();

  it("accepts current true-position timestamps", () => {
    expect(isFreshVehicleObservation("2026-07-15T11:59:00Z", now)).toBe(true);
  });

  it.each([
    "2026-07-15T11:57:59Z",
    "",
    "not-a-date",
    "2026-07-15T12:00:01Z",
  ])("rejects stale, missing, invalid, or future timestamps (%s)", (timestamp) => {
    expect(isFreshVehicleObservation(timestamp, now)).toBe(false);
  });
});
