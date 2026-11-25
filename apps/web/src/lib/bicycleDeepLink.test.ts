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
      bikePreferSmoothSurfaces: true,
      bikeSpeedKmh: 19.5,
    });
    expect(new URL(url).searchParams.get("bikePreferQuietRoads")).toBe("1");
    expect(new URL(url).searchParams.get("bikePreferSmoothSurfaces")).toBe("1");
    expect(parseDeepLinkSearch(new URL(url).search).directions).toMatchObject({
      bikeProfile: "gravel",
      bikeHillPreference: "strongly-avoid",
      bikePreferQuietRoads: true,
      bikePreferSmoothSurfaces: true,
      bikeSpeedKmh: 19.5,
    });
  });
  it("defaults cycling links and ignores malformed fields", () => {
    expect(
      parseDeepLinkSearch(
        "?panel=directions&mode=cycling&bikeProfile=car&bikePreferQuietRoads=true",
      ).directions,
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

it.each(["", "0", "61", "NaN", "Infinity"])("ignores malformed speed %s in links", (speed) => {
  expect(
    parseDeepLinkSearch(`?panel=directions&mode=cycling&bikeSpeedKmh=${speed}`).directions,
  ).not.toHaveProperty("bikeSpeedKmh");
});
