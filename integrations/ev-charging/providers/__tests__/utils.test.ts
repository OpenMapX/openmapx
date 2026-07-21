import { describe, expect, it } from "vitest";
import { dotNlLocationPoiId, groupConnectors } from "../utils.js";

describe("groupConnectors", () => {
  it("groups identical connectors into one row, summing quantity", () => {
    const grouped = groupConnectors([
      { type: "Type 2", powerKw: 22, currentType: "AC", quantity: 1, status: "operational" },
      { type: "Type 2", powerKw: 22, currentType: "AC", quantity: 1, status: "operational" },
      { type: "Type 2", powerKw: 22, currentType: "AC", quantity: 1, status: "operational" },
      { type: "Type 2", powerKw: 22, currentType: "AC", quantity: 1, status: "operational" },
      { type: "Type 2", powerKw: 22, currentType: "AC", quantity: 1, status: "operational" },
      { type: "Type 2", powerKw: 22, currentType: "AC", quantity: 1, status: "operational" },
    ]);
    expect(grouped).toHaveLength(1);
    expect(grouped[0]).toMatchObject({
      type: "Type 2",
      powerKw: 22,
      currentType: "AC",
      quantity: 6,
      status: "operational",
    });
  });

  it("sums each member's own quantity rather than counting connectors", () => {
    const grouped = groupConnectors([
      { type: "CCS", powerKw: 50, currentType: "DC", quantity: 2 },
      { type: "CCS", powerKw: 50, currentType: "DC", quantity: 3 },
    ]);
    expect(grouped).toEqual([{ type: "CCS", powerKw: 50, currentType: "DC", quantity: 5 }]);
  });

  it("treats a missing quantity as 1", () => {
    const grouped = groupConnectors([
      { type: "CHAdeMO", powerKw: 50, currentType: "DC" },
      { type: "CHAdeMO", powerKw: 50, currentType: "DC" },
    ]);
    expect(grouped[0].quantity).toBe(2);
  });

  it("keeps distinct types/power/current as separate groups, sorted by descending power", () => {
    const grouped = groupConnectors([
      { type: "Type 2", powerKw: 22, currentType: "AC", quantity: 4 },
      { type: "CCS", powerKw: 150, currentType: "DC", quantity: 1 },
      { type: "CHAdeMO", powerKw: 50, currentType: "DC", quantity: 2 },
    ]);
    expect(grouped.map((c) => c.type)).toEqual(["CCS", "CHAdeMO", "Type 2"]);
    expect(grouped.map((c) => c.powerKw)).toEqual([150, 50, 22]);
  });

  it("drops status when members of a group disagree, keeps it when they agree", () => {
    const grouped = groupConnectors([
      { type: "Type 2", powerKw: 22, currentType: "AC", quantity: 1, status: "operational" },
      { type: "Type 2", powerKw: 22, currentType: "AC", quantity: 1, status: "not-operational" },
    ]);
    expect(grouped[0].status).toBeUndefined();
  });

  it("does not carry the per-connector reference field into the grouped result", () => {
    const grouped = groupConnectors([
      { type: "Type 2", powerKw: 22, currentType: "AC", quantity: 1, reference: "A1" },
    ]);
    expect(grouped[0]).not.toHaveProperty("reference");
  });

  it("returns an empty array for no connectors", () => {
    expect(groupConnectors([])).toEqual([]);
  });
});

// This is the SAME helper imported by both netherlands-parser.ts (static)
// and netherlands-live-parser.ts (live) — asserting its behavior here is
// what guarantees the two parsers derive identical poiIds for the same
// OCPI Location, which live-merge depends on to join a status update back
// onto the right static station row.
describe("dotNlLocationPoiId", () => {
  it("builds a composite country+party+id key, uppercasing country/party but keeping id opaque", () => {
    const poiId = dotNlLocationPoiId({
      id: "abc-123",
      country_code: "nl",
      party_id: "gfx",
    });
    expect(poiId).toBe(encodeURIComponent("NL*GFX*abc-123"));
  });

  it("gives different CPOs reusing the same location.id distinct poiIds", () => {
    const a = dotNlLocationPoiId({ id: "shared", country_code: "NL", party_id: "AAA" });
    const b = dotNlLocationPoiId({ id: "shared", country_code: "NL", party_id: "BBB" });
    expect(a).not.toBe(b);
  });

  it("falls back to id alone only when both country_code and party_id are absent", () => {
    expect(dotNlLocationPoiId({ id: "opaque-id" })).toBe(encodeURIComponent("opaque-id"));
  });

  it("still folds in whichever of country_code/party_id is present alone", () => {
    expect(dotNlLocationPoiId({ id: "abc", country_code: "NL" })).toBe(
      encodeURIComponent("NL*abc"),
    );
    expect(dotNlLocationPoiId({ id: "abc", party_id: "GFX" })).toBe(encodeURIComponent("GFX*abc"));
  });

  it("returns undefined when id is missing or blank", () => {
    expect(dotNlLocationPoiId({ country_code: "NL", party_id: "GFX" })).toBeUndefined();
    expect(dotNlLocationPoiId({ id: "   ", country_code: "NL", party_id: "GFX" })).toBeUndefined();
  });
});
