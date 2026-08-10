import { describe, expect, it } from "vitest";
import { isRecentMapDataQueryKey } from "./recentMapDataCache";

describe("isRecentMapDataQueryKey", () => {
  for (const root of [
    "place",
    "weather",
    "isochrone",
    "sun-times",
    "directions",
    "route",
    "geocode",
  ]) {
    it(`keeps the existing ${root} map-data root persistable`, () => {
      expect(isRecentMapDataQueryKey([root, "fixture"])).toBe(true);
    });
  }

  it("rejects personal timeline days from persisted query storage", () => {
    expect(isRecentMapDataQueryKey(["personalTimeline", "day", "2026-08-09"])).toBe(false);
  });
});
