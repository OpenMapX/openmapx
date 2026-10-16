import { describe, expect, it } from "vitest";
import {
  createDirectionsCacheIdentity,
  DIRECTIONS_REQUEST_POLICY,
  parseDirectionsRequest,
} from "../directions-request";
import { createScheduleCacheIdentity, parseScheduleRequest } from "../schedule-request";

const waypoints = "6.08,50.775;6.1,50.78";
const points = [
  [6.08, 50.775],
  [6.1, 50.78],
];
const parse = (extra: Record<string, string> = {}) =>
  parseDirectionsRequest({ waypoints, mode: "cycling", ...extra }, DIRECTIONS_REQUEST_POLICY);
describe("cycling preference boundaries", () => {
  it("normalizes defaults and keeps other modes independent", () => {
    expect(parse().routingOptions).toMatchObject({
      bikeProfile: "trekking",
      bikeHillPreference: "default",
      bikePreferQuietRoads: false,
    });
    expect(parse({ mode: "walking", bikeProfile: "road" }).routingOptions).not.toHaveProperty(
      "bikeProfile",
    );
  });
  it.each(["trekking", "road", "gravel", "mountain"])(
    "accepts %s and separates cache identity",
    (bikeProfile) => {
      const req = parse({ bikeProfile, bikeHillPreference: "avoid", bikePreferQuietRoads: "true" });
      expect(req.routingOptions).toMatchObject({
        bikeProfile,
        bikeHillPreference: "avoid",
        bikePreferQuietRoads: true,
      });
      expect(createDirectionsCacheIdentity(req, null)).toMatchObject({
        bikeProfile,
        bikeHillPreference: "avoid",
        bikePreferQuietRoads: true,
      });
    },
  );
  it.each([
    { bikeProfile: "car" },
    { bikeHillPreference: "flat" },
    { bikePreferQuietRoads: "yes" },
    { bikePreferSmoothSurfaces: "yes" },
    ...["", "0", "4.9", "60.1", "NaN", "Infinity", "20km/h"].map((bikeSpeedKmh) => ({
      bikeSpeedKmh,
    })),
  ])("rejects invalid cycling values %j", (values) => expect(() => parse(values)).toThrow(/bike/));
  it("preserves and validates scheduled cycling options", () => {
    const req = parseScheduleRequest({
      waypoints: points,
      mode: "cycling",
      bikeProfile: "mountain",
      bikeHillPreference: "strongly-avoid",
      bikePreferQuietRoads: true,
    });
    expect(createScheduleCacheIdentity(req, null)).toMatchObject({
      bikeProfile: "mountain",
      bikeHillPreference: "strongly-avoid",
      bikePreferQuietRoads: true,
    });
    expect(() =>
      parseScheduleRequest({ waypoints: points, mode: "cycling", bikePreferQuietRoads: "true" }),
    ).toThrow(/bike/);
  });
});

it("preserves surface and decimal pace through ordinary, optimize and schedule identities", () => {
  const req = parse({ bikeSpeedKmh: "19.5", bikePreferSmoothSurfaces: "true" });
  expect(req.routingOptions).toMatchObject({ bikeSpeedKmh: 19.5, bikePreferSmoothSurfaces: true });
  expect(createDirectionsCacheIdentity(req, null)).toMatchObject({
    bikeSpeedKmh: 19.5,
    bikePreferSmoothSurfaces: true,
  });
  const scheduled = parseScheduleRequest({
    waypoints: points,
    mode: "cycling",
    bikeSpeedKmh: 19.5,
    bikePreferSmoothSurfaces: true,
  });
  expect(createScheduleCacheIdentity(scheduled, null)).toMatchObject({
    bikeSpeedKmh: 19.5,
    bikePreferSmoothSurfaces: true,
  });
});

it.each([5, 60])("accepts cruising-speed boundary %s", (bikeSpeedKmh) => {
  expect(parse({ bikeSpeedKmh: String(bikeSpeedKmh) }).routingOptions.bikeSpeedKmh).toBe(
    bikeSpeedKmh,
  );
});

it.each([null, "20", 4.9, 60.1, NaN, Infinity])(
  "rejects malformed scheduled speed %s",
  (bikeSpeedKmh) => {
    expect(() =>
      parseScheduleRequest({ waypoints: points, mode: "cycling", bikeSpeedKmh }),
    ).toThrow(/bike/);
  },
);
