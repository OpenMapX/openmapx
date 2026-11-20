import { describe, expect, it } from "vitest";
import { getOverviewConsumedKeys } from "./PlaceTagDetails";

describe("getOverviewConsumedKeys", () => {
  it("keeps every tag a detail row, the social row or another card section shows out of other details", () => {
    const shown = {
      operator: "Operator",
      "operator:wikipedia": "de:Operator",
      "brand:wikidata": "Q1",
      network: "Network",
      "contact:email": "a@example.com",
      charge: "2 EUR",
      "toilets:wheelchair": "yes",
      shower: "no",
      model: "S1",
      denomination: "catholic",
      "contact:vimeo": "kram",
      "contact:phone": "+49",
      "ref:yelp": "kram",
      image: "https://example.com/a.jpg",
      "image:2": "https://example.com/b.jpg",
      "description:de": "Klein",
      "addr:location": "Hinterhof",
    };
    const other = { name: "Café Kram", amenity: "cafe", opening_hours: "Mo-Fr 08:00-18:00" };
    expect([...getOverviewConsumedKeys({ ...shown, ...other })].sort()).toEqual(
      Object.keys(shown).sort(),
    );
  });
});
