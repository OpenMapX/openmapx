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
