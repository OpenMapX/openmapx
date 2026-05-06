import type { Place } from "@openmapx/core";
import { describe, expect, it } from "vitest";
import { shouldBuildReviewFallbackSearch } from "../review-link-fallback-policy";

function place(overrides: Partial<Place> = {}): Place {
  return {
    id: "osm:node/1",
    primaryScheme: "osm",
    ids: { osm: "node/1" },
    name: "Cafe Central",
    address: "Herrengasse 14, Vienna",
    coordinates: [16.365, 48.21],
    ...overrides,
  };
}

describe("shouldBuildReviewFallbackSearch", () => {
  it("allows Google Maps fallback search broadly", () => {
    expect(
      shouldBuildReviewFallbackSearch(
        "googleMaps",
        place({ category: "atm", rawCategory: "amenity/atm", osmTags: { amenity: "atm" } }),
      ),
    ).toBe(true);
  });

  it("keeps direct-only platforms out of fallback search", () => {
    const subject = place({ category: "restaurant", osmTags: { amenity: "restaurant" } });

    expect(shouldBuildReviewFallbackSearch("foursquare", subject)).toBe(false);
    expect(shouldBuildReviewFallbackSearch("instagram", subject)).toBe(false);
    expect(shouldBuildReviewFallbackSearch("facebook", subject)).toBe(false);
  });

  it("allows Yelp fallback for local-service categories beyond Tripadvisor", () => {
    const subject = place({
      category: "supermarket",
      rawCategory: "shop/supermarket",
      osmTags: { shop: "supermarket" },
    });

    expect(shouldBuildReviewFallbackSearch("yelp", subject)).toBe(true);
    expect(shouldBuildReviewFallbackSearch("tripadvisor", subject)).toBe(false);
  });

  it("allows Tripadvisor fallback for travel and hospitality places", () => {
    expect(
      shouldBuildReviewFallbackSearch(
        "tripadvisor",
        place({ rawCategory: "tourism/museum", osmTags: { tourism: "museum" } }),
      ),
    ).toBe(true);
  });

  it("blocks unknown schemes and noisy infrastructure categories", () => {
    const subject = place({ rawCategory: "amenity/atm", osmTags: { amenity: "atm" } });

    expect(shouldBuildReviewFallbackSearch("unknown", subject)).toBe(false);
    expect(shouldBuildReviewFallbackSearch("yelp", subject)).toBe(false);
    expect(shouldBuildReviewFallbackSearch("tripadvisor", subject)).toBe(false);
  });
});
