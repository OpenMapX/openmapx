import { describe, expect, it } from "vitest";
import {
  buildFacebookUrl,
  buildFoursquareUrl,
  buildGoogleMapsUrl,
  buildInstagramUrl,
  buildYelpUrl,
  getIdSchemeView,
  registerBuiltinIdSchemeViews,
} from ".";

describe("external platform URL builders", () => {
  it("normalizes Google Maps CIDs and validates Google Maps URLs", () => {
    expect(buildGoogleMapsUrl("123456789012345")).toBe(
      "https://www.google.com/maps?cid=123456789012345",
    );
    expect(
      buildGoogleMapsUrl("https://www.google.com/maps/place/Cafe?cid=123&utm_source=x#details"),
    ).toBe("https://www.google.com/maps/place/Cafe?cid=123");
    expect(buildGoogleMapsUrl("https://www.google.com/search?q=Cafe")).toBeUndefined();
    expect(buildGoogleMapsUrl("https://google.evil/maps/place/Cafe")).toBeUndefined();
    expect(buildGoogleMapsUrl("not-a-cid")).toBeUndefined();
  });

  it("normalizes Yelp business slugs and rejects non-business URLs", () => {
    expect(buildYelpUrl("cafe-central-vienna")).toBe(
      "https://www.yelp.com/biz/cafe-central-vienna",
    );
    expect(buildYelpUrl("https://www.yelp.com/biz/cafe-central-vienna?utm_source=x&osq=Cafe")).toBe(
      "https://www.yelp.com/biz/cafe-central-vienna",
    );
    expect(buildYelpUrl("https://www.yelp.com/search?find_desc=Cafe")).toBeUndefined();
    expect(buildYelpUrl("https://yelp.com.evil.example/biz/cafe")).toBeUndefined();
  });

  it("normalizes Foursquare venue IDs and validates hosts", () => {
    expect(buildFoursquareUrl("4b0588d7f964a52007a722e3")).toBe(
      "https://foursquare.com/v/4b0588d7f964a52007a722e3",
    );
    expect(buildFoursquareUrl("https://foursquare.com/v/cafe/4b0588d7f964a52007a722e3?ref=x")).toBe(
      "https://foursquare.com/v/cafe/4b0588d7f964a52007a722e3",
    );
    expect(buildFoursquareUrl("https://foursquare.com.evil.example/v/cafe")).toBeUndefined();
    expect(buildFoursquareUrl("not-a-venue-id")).toBeUndefined();
  });

  it("normalizes Instagram handles and rejects content URLs", () => {
    expect(buildInstagramUrl("@openmapx.project")).toBe(
      "https://www.instagram.com/openmapx.project/",
    );
    expect(buildInstagramUrl("https://www.instagram.com/openmapx.project/?hl=en")).toBe(
      "https://www.instagram.com/openmapx.project/",
    );
    expect(buildInstagramUrl("https://www.instagram.com/p/abc123/")).toBeUndefined();
    expect(buildInstagramUrl("https://instagram.com.evil.example/openmapx")).toBeUndefined();
  });

  it("normalizes Facebook page references and rejects unsafe routes", () => {
    expect(buildFacebookUrl("openmapx.project")).toBe("https://www.facebook.com/openmapx.project");
    expect(buildFacebookUrl("12345678901")).toBe(
      "https://www.facebook.com/profile.php?id=12345678901",
    );
    expect(buildFacebookUrl("https://m.facebook.com/profile.php?id=12345678901&utm_source=x")).toBe(
      "https://www.facebook.com/profile.php?id=12345678901",
    );
    expect(
      buildFacebookUrl("https://facebook.com/sharer/sharer.php?u=https://example.com"),
    ).toBeUndefined();
    expect(buildFacebookUrl("https://facebook.com.evil.example/openmapx")).toBeUndefined();
  });

  it("wires the builders into the builtin id-scheme views", () => {
    registerBuiltinIdSchemeViews();

    expect(getIdSchemeView("googleMaps")?.buildUrl?.("123456789012345")).toBe(
      "https://www.google.com/maps?cid=123456789012345",
    );
    expect(getIdSchemeView("yelp")?.buildUrl?.("cafe-central-vienna")).toBe(
      "https://www.yelp.com/biz/cafe-central-vienna",
    );
    expect(getIdSchemeView("instagram")?.buildUrl?.("@openmapx")).toBe(
      "https://www.instagram.com/openmapx/",
    );
  });
});
