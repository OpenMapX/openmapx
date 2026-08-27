import { describe, expect, it } from "vitest";
import { buildPlaceDetailsRequest } from "./placeDetails";

describe("buildPlaceDetailsRequest", () => {
  it("gives the same canonical coordinates to cache identity and HTTP params", () => {
    const request = buildPlaceDetailsRequest({
      id: "custom-1",
      coordinates: [13.40000049, 52.50000049],
      name: "  Gate  ",
      lang: undefined,
      hasAddress: undefined,
    });

    expect(request).toEqual({
      identity: {
        id: "custom-1",
        lng: 13.4,
        lat: 52.5,
        name: "Gate",
        lang: null,
        hasAddress: false,
      },
      params: { lng: "13.4", lat: "52.5", name: "Gate" },
    });
  });

  it("keeps same-id places at meaningfully different coordinates distinct", () => {
    const first = buildPlaceDetailsRequest({ id: "custom-1", coordinates: [13.4, 52.5] });
    const second = buildPlaceDetailsRequest({ id: "custom-1", coordinates: [13.5, 52.6] });

    expect(second.identity).not.toEqual(first.identity);
  });

  it("distinguishes an omitted language from explicit English", () => {
    const implicit = buildPlaceDetailsRequest({ id: "eva:1" });
    const english = buildPlaceDetailsRequest({ id: "eva:1", lang: "en" });

    expect(implicit.identity.lang).toBeNull();
    expect(english.identity.lang).toBe("en");
    expect(english.identity).not.toEqual(implicit.identity);
  });
});
