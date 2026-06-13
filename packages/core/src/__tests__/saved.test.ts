import { describe, expect, it } from "vitest";
import { isLabeledPlace } from "../types/saved";

const valid = {
  id: "abc",
  label: "home",
  icon: null,
  name: "Home",
  address: null,
  lat: 50.78,
  lng: 6.08,
  placeId: null,
};

describe("isLabeledPlace", () => {
  it("accepts a well-formed labeled place", () => {
    expect(isLabeledPlace(valid)).toBe(true);
  });

  it("rejects the legacy quick-label shape that lacks label/name", () => {
    // Old offline mirrors stored `{ id: "home" }` with no label/name; seeding
    // that into the cache crashed the search filter (translatedLabel.toLowerCase()).
    expect(isLabeledPlace({ id: "home" })).toBe(false);
  });

  it("rejects entries missing required string/number fields", () => {
    expect(isLabeledPlace({ ...valid, name: undefined })).toBe(false);
    expect(isLabeledPlace({ ...valid, label: 5 })).toBe(false);
    expect(isLabeledPlace({ ...valid, lat: "50.78" })).toBe(false);
    expect(isLabeledPlace(null)).toBe(false);
    expect(isLabeledPlace(undefined)).toBe(false);
  });
});
