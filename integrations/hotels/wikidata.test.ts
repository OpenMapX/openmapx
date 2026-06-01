// integrations/hotels/wikidata.test.ts
import { describe, expect, it } from "vitest";
import fixture from "./__fixtures__/wikidata-windsor-palace.json" with { type: "json" };
import { parseWikidataOtaIds } from "./wikidata.js";

describe("parseWikidataOtaIds", () => {
  it("extracts the OTA ids present on the entity (real captured values)", () => {
    const ids = parseWikidataOtaIds(fixture, "Q12231151");
    expect(ids.expedia).toBe("h7172034"); // P5651
    expect(ids.booking).toBe("eg/windsor-palace"); // P3607
    expect(ids.hotelscom).toBe("ho326672"); // P3898
    expect(ids.agoda).toBe("paradise-inn-windsor-palace-hotel/hotel/alexandria-eg"); // P6008 slug
    expect(ids.tripcom).toBe("2565026"); // P10425
  });
  it("returns an empty object for an entity with no OTA ids", () => {
    expect(parseWikidataOtaIds({ entities: { Q1: { claims: {} } } }, "Q1")).toEqual({});
  });
  it("ignores a missing entity safely", () => {
    expect(parseWikidataOtaIds({ entities: {} }, "Q1")).toEqual({});
  });
});
