import { describe, expect, it } from "vitest";
import type { Place } from "../types/place";
import { isLodging } from "./lodgingPlace";

function place(partial: Partial<Place>): Place {
  return {
    id: "test:1",
    name: "Test",
    address: "",
    coordinates: [13.4, 52.5],
    ...partial,
  } as Place;
}

describe("isLodging", () => {
  it("matches OSM tourism=hotel", () => {
    expect(isLodging(place({ osmTags: { tourism: "hotel" } }))).toBe(true);
  });
  it("matches hostel / motel / guest_house / apartment", () => {
    for (const t of ["hostel", "motel", "guest_house", "apartment", "chalet", "alpine_hut"]) {
      expect(isLodging(place({ osmTags: { tourism: t } }))).toBe(true);
    }
  });
  it("matches a resolved category", () => {
    expect(isLodging(place({ category: "Hotel" }))).toBe(true);
    expect(isLodging(place({ category: "Guest house" }))).toBe(true);
  });
  it("matches a raw-category segment", () => {
    expect(isLodging(place({ rawCategory: "tourism/hotel" }))).toBe(true);
  });
  it("does NOT match non-lodging places", () => {
    expect(isLodging(place({ osmTags: { amenity: "restaurant" } }))).toBe(false);
    expect(isLodging(place({ category: "Restaurant" }))).toBe(false);
    expect(isLodging(place({ rawCategory: "shop/hostelry_supplies" }))).toBe(false); // no false substring hit
  });
  it("does NOT substring-match a token containing 'hotel'", () => {
    // This is the whole point of segment-matching over .includes(): a value
    // that merely *contains* "hotel" must not match. A refactor back to
    // `.includes("hotel")` would fail this test.
    expect(isLodging(place({ rawCategory: "shop/hotelware" }))).toBe(false);
    expect(isLodging(place({ category: "Hotelware shop" }))).toBe(false);
  });
});
