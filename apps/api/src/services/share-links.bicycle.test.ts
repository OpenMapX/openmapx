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
        bikePreferSmoothSurfaces: true,
        bikeSpeedKmh: 19.5,
      }),
    ).toMatchObject({
      bikeProfile: "road",
      bikeHillPreference: "avoid",
      bikePreferQuietRoads: true,
      bikePreferSmoothSurfaces: true,
      bikeSpeedKmh: 19.5,
    }));
  it.each([
    { bikeProfile: "car" },
    { bikeHillPreference: "flat" },
    { bikePreferQuietRoads: "true" },
    { bikePreferSmoothSurfaces: "true" },
    ...[null, "20", 0, 61, NaN, Infinity].map((bikeSpeedKmh) => ({ bikeSpeedKmh })),
  ])("rejects malformed fields %j", (fields) =>
    expect(validateRouteShare({ ...base, ...fields })).toBeNull(),
  );
  it("keeps legacy snapshots readable", () => expect(validateRouteShare(base)).toEqual(base));
});
