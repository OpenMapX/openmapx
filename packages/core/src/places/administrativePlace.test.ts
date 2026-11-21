import { describe, expect, it } from "vitest";
import type { Place } from "../types/place";
import { isCityOrSmaller } from "./administrativePlace";

function place(partial: Partial<Place>): Place {
  return {
    id: "test:1",
    name: "Test",
    address: "",
    coordinates: [13.4, 52.5],
    ...partial,
  } as Place;
}

describe("isCityOrSmaller", () => {
  it("matches settlement place tags", () => {
    for (const p of ["city", "town", "village", "hamlet", "suburb", "neighbourhood", "quarter"]) {
      expect(isCityOrSmaller(place({ osmTags: { place: p } }))).toBe(true);
    }
  });

  it("matches administrative boundaries at admin_level >= 6", () => {
    expect(
      isCityOrSmaller(place({ osmTags: { boundary: "administrative", admin_level: "6" } })),
    ).toBe(true);
    expect(
      isCityOrSmaller(place({ osmTags: { boundary: "administrative", admin_level: "8" } })),
    ).toBe(true);
  });

  it("rejects countries, states and broad regions", () => {
    expect(isCityOrSmaller(place({ osmTags: { place: "country" } }))).toBe(false);
    expect(isCityOrSmaller(place({ osmTags: { place: "state" } }))).toBe(false);
    expect(isCityOrSmaller(place({ osmTags: { place: "region" } }))).toBe(false);
    expect(
      isCityOrSmaller(place({ osmTags: { boundary: "administrative", admin_level: "4" } })),
    ).toBe(false);
    expect(
      isCityOrSmaller(place({ osmTags: { boundary: "administrative", admin_level: "5" } })),
    ).toBe(false);
  });

  it("rejects ordinary POIs and tagless places", () => {
    expect(isCityOrSmaller(place({ osmTags: { tourism: "hotel" } }))).toBe(false);
    expect(isCityOrSmaller(place({ category: "Restaurant" }))).toBe(false);
    expect(isCityOrSmaller(place({}))).toBe(false);
  });
});
