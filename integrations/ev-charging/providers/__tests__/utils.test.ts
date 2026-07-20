import { describe, expect, it } from "vitest";
import { groupConnectors } from "../utils.js";

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
