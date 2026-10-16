import { describe, expect, it } from "vitest";
import { validateRouteShare } from "./share-links";

const base = {
  mode: "cycling",
  waypoints: [
    { lat: 50, lng: 6 },
    { lat: 51, lng: 7 },
  ],
};
describe("cycling share snapshots", () => {
  it("preserves optional preferences", () =>
    expect(
      validateRouteShare({
        ...base,
        bikeProfile: "road",
        bikeHillPreference: "avoid",
        bikePreferQuietRoads: true,
      }),
    ).toMatchObject({
      bikeProfile: "road",
      bikeHillPreference: "avoid",
      bikePreferQuietRoads: true,
    }));
  it.each([
    { bikeProfile: "car" },
    { bikeHillPreference: "flat" },
    { bikePreferQuietRoads: "true" },
  ])("rejects malformed fields %j", (fields) =>
    expect(validateRouteShare({ ...base, ...fields })).toBeNull(),
  );
  it("keeps legacy snapshots readable", () => expect(validateRouteShare(base)).toEqual(base));
});
