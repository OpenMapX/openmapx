import { describe, expect, it } from "vitest";
import { isFreshVehicleObservation } from "../freshness.js";

describe("isFreshVehicleObservation", () => {
  const now = new Date("2026-07-15T12:00:00Z").getTime();

  it("accepts current true-position timestamps", () => {
    expect(isFreshVehicleObservation("2026-07-15T11:59:00Z", now)).toBe(true);
  });

  it.each([
    "2026-07-15T12:00:01Z", // 1s ahead — server/client clock skew
    "2026-07-15T12:00:45Z", // 45s ahead — still within skew tolerance
  ])("tolerates near-future timestamps from clock skew (%s)", (timestamp) => {
    expect(isFreshVehicleObservation(timestamp, now)).toBe(true);
  });

  it.each([
    "2026-07-15T11:57:59Z", // >2min old — stale
    "",
    "not-a-date",
    "2026-07-15T12:01:30Z", // 90s ahead — beyond skew tolerance
  ])("rejects stale, missing, invalid, or far-future timestamps (%s)", (timestamp) => {
    expect(isFreshVehicleObservation(timestamp, now)).toBe(false);
  });
});
