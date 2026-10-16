import { describe, expect, it } from "vitest";
import { buildDirectionsDeepLinkUrl, parseDeepLinkSearch } from "./deepLink";

describe("cycling route links", () => {
  it("round-trips preferences with the route", () => {
    const url = buildDirectionsDeepLinkUrl("https://openmapx.com", {
      mode: "cycling",
      waypoints: [{ coords: [6, 50] }, { coords: [7, 51] }],
      bikeProfile: "gravel",
      bikeHillPreference: "strongly-avoid",
      bikePreferQuietRoads: true,
    });
    expect(parseDeepLinkSearch(new URL(url).search).directions).toMatchObject({
      bikeProfile: "gravel",
      bikeHillPreference: "strongly-avoid",
      bikePreferQuietRoads: true,
    });
  });
  it("defaults legacy cycling links and ignores malformed fields", () => {
    expect(
      parseDeepLinkSearch("?panel=directions&mode=cycling&bikeProfile=car&bikePreferQuietRoads=yes")
        .directions,
    ).toMatchObject({
      bikeProfile: "trekking",
      bikeHillPreference: "default",
      bikePreferQuietRoads: false,
    });
    expect(
      parseDeepLinkSearch("?panel=directions&mode=driving&bikeProfile=road").directions,
    ).not.toHaveProperty("bikeProfile");
  });
});
