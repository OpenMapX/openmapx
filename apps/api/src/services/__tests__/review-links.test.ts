import { type Place, registerBuiltinIdSchemeViews } from "@openmapx/core";
import { beforeAll, describe, expect, it } from "vitest";
import { buildReviewLinks } from "../review-links";

function place(overrides: Partial<Place> = {}): Place {
  return {
    id: "osm:node/1",
    primaryScheme: "osm",
    ids: { osm: "node/1" },
    name: "Cafe Central",
    address: "Herrengasse 14, Vienna",
    city: "Vienna",
    countryCode: "at",
    coordinates: [16.365, 48.21],
    category: "cafe",
    rawCategory: "amenity/cafe",
    osmTags: { amenity: "cafe" },
    ...overrides,
  };
}

describe("buildReviewLinks", () => {
  beforeAll(() => {
    registerBuiltinIdSchemeViews();
  });

  it("marks OSM Tripadvisor references as direct high-confidence links", () => {
    const links = buildReviewLinks(
      place({
        osmTags: {
          amenity: "restaurant",
          "contact:tripadvisor": "Restaurant_Review-g190454-d123456-Reviews-Cafe.html",
        },
      }),
    );

    expect(links.find((link) => link.platform === "Tripadvisor")).toEqual({
      platform: "Tripadvisor",
      url: "https://www.tripadvisor.com/Restaurant_Review-g190454-d123456-Reviews-Cafe.html",
      kind: "direct",
      source: "osm",
      confidence: "high",
    });
  });

  it("uses Wikidata-sourced ids when no valid OSM value exists", () => {
    const links = buildReviewLinks(
      place({
        ids: {
          osm: "node/1",
          tripadvisor: "Attraction_Review-g187147-d188151-Reviews-Eiffel_Tower.html",
        },
        osmTags: {
          amenity: "restaurant",
          "contact:tripadvisor": "https://tripadvisor.com.evil.example/fake",
        },
      }),
    );

    expect(links.find((link) => link.platform === "Tripadvisor")).toEqual({
      platform: "Tripadvisor",
      url: "https://www.tripadvisor.com/Attraction_Review-g187147-d188151-Reviews-Eiffel_Tower.html",
      kind: "direct",
      source: "wikidata",
      confidence: "high",
    });
  });

  it("builds category-gated Tripadvisor fallback searches with place context", () => {
    const links = buildReviewLinks(place());

    expect(links.find((link) => link.platform === "Tripadvisor")).toEqual({
      platform: "Tripadvisor",
      url: "https://www.tripadvisor.com/Search?q=Cafe%20Central%20Vienna%20AT",
      kind: "search",
      source: "fallback",
      confidence: "low",
    });
  });

  it("builds Yelp fallback searches only for review-relevant categories", () => {
    const links = buildReviewLinks(place());

    expect(links.find((link) => link.platform === "Yelp")).toEqual({
      platform: "Yelp",
      url: "https://www.yelp.com/search?find_desc=Cafe%20Central&find_loc=48.21,16.365",
      kind: "search",
      source: "fallback",
      confidence: "low",
    });
  });

  it("does not show noisy fallback searches for irrelevant categories", () => {
    const links = buildReviewLinks(
      place({
        name: "Cash Point",
        address: "Main Street",
        city: undefined,
        countryCode: undefined,
        category: "atm",
        rawCategory: "amenity/atm",
        osmTags: { amenity: "atm" },
      }),
    );

    expect(links.find((link) => link.platform === "Tripadvisor")).toBeUndefined();
    expect(links.find((link) => link.platform === "Yelp")).toBeUndefined();
  });

  it("keeps direct Tripadvisor links even when the category is not fallback-eligible", () => {
    const links = buildReviewLinks(
      place({
        category: "atm",
        rawCategory: "amenity/atm",
        ids: { osm: "node/1", tripadvisor: "Attraction_Review-g1-d2.html" },
        osmTags: { amenity: "atm" },
      }),
    );

    expect(links.find((link) => link.platform === "Tripadvisor")).toEqual(
      expect.objectContaining({
        url: "https://www.tripadvisor.com/Attraction_Review-g1-d2.html",
        kind: "direct",
      }),
    );
  });

  it("keeps direct Yelp links even when the category is not fallback-eligible", () => {
    const links = buildReviewLinks(
      place({
        category: "atm",
        rawCategory: "amenity/atm",
        ids: { osm: "node/1", yelp: "cash-point-vienna" },
        osmTags: { amenity: "atm" },
      }),
    );

    expect(links.find((link) => link.platform === "Yelp")).toEqual({
      platform: "Yelp",
      url: "https://www.yelp.com/biz/cash-point-vienna",
      kind: "direct",
      source: "wikidata",
      confidence: "high",
    });
  });
});
