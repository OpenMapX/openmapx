import { describe, expect, it } from "vitest";
import { filterImagesByHeading, parseStreetLevelSearchQuery } from "../street-level-search";

describe("parseStreetLevelSearchQuery", () => {
  it("accepts a full query with defaults", () => {
    const parsed = parseStreetLevelSearchQuery({
      lng: "6.676",
      lat: "51.179",
      radius: "400",
      heading: "283",
      headingTolerance: "30",
      after: "2018-01-01",
      lookAtLng: "6.676",
      lookAtLat: "51.179",
      limit: "20",
    });
    expect(parsed).toEqual({
      lngLat: [6.676, 51.179],
      radiusM: 400,
      heading: 283,
      headingToleranceDeg: 30,
      capturedAfter: "2018-01-01",
      lookingAt: [6.676, 51.179],
      limit: 20,
    });
  });

  it("applies the radius and limit bounds", () => {
    expect(parseStreetLevelSearchQuery({ lng: "6", lat: "51", radius: "1001" })).toBeNull();
    expect(parseStreetLevelSearchQuery({ lng: "6", lat: "51", radius: "0" })).toBeNull();
    expect(
      parseStreetLevelSearchQuery({ lng: "6", lat: "51", radius: "100", limit: "51" }),
    ).toBeNull();
    expect(parseStreetLevelSearchQuery({ lng: "6", lat: "51", radius: "100" })?.limit).toBe(20);
  });

  it("rejects missing or invalid coordinates", () => {
    expect(parseStreetLevelSearchQuery({ lng: "nope", lat: "51", radius: "100" })).toBeNull();
    expect(parseStreetLevelSearchQuery({ lng: "181", lat: "51", radius: "100" })).toBeNull();
    expect(parseStreetLevelSearchQuery({ lng: "6", lat: "91", radius: "100" })).toBeNull();
    expect(parseStreetLevelSearchQuery({ radius: "100" })).toBeNull();
  });

  it("ignores a half-given or invalid look-at point", () => {
    expect(
      parseStreetLevelSearchQuery({ lng: "6", lat: "51", radius: "100", lookAtLng: "6" })
        ?.lookingAt,
    ).toBeUndefined();
    expect(
      parseStreetLevelSearchQuery({
        lng: "6",
        lat: "51",
        radius: "100",
        lookAtLng: "200",
        lookAtLat: "51",
      })?.lookingAt,
    ).toBeUndefined();
  });
});

describe("filterImagesByHeading", () => {
  const images = [{ heading: 283 }, { heading: 97 }, {}] as { heading?: number }[];

  it("keeps images within the tolerance of the target heading", () => {
    expect(filterImagesByHeading(images, 283, 30)).toEqual([{ heading: 283 }]);
  });

  it("passes everything through when no heading filter is requested", () => {
    expect(filterImagesByHeading(images, undefined, 30)).toEqual(images);
  });
});
