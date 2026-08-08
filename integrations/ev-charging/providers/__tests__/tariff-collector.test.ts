import type { EvChargingConnector, EvChargingTariff } from "@openmapx/mobility-core/ev-charging";
import { describe, expect, it } from "vitest";
import { createTariffCollector } from "../tariff-collector.js";

// Factories, not shared constants: parsers build a distinct object per physical
// connector, and the collector relies on that identity to count them.
const ccs = (): EvChargingConnector => ({ type: "CCS", powerKw: 60, currentType: "DC" });
const type2 = (): EvChargingConnector => ({ type: "Type 2", powerKw: 11, currentType: "AC" });

function tariff(price: number): EvChargingTariff {
  return {
    elements: [{ type: "energy", price, currency: "EUR" }],
    scope: "cpo",
    source: "de-ocpdb",
    updatedAt: "2026-07-01T00:00:00.000Z",
  };
}

describe("createTariffCollector", () => {
  it("returns nothing when no tariff was ever added", () => {
    const collector = createTariffCollector();
    collector.add([ccs()], []);
    expect(collector.build([ccs()])).toBeUndefined();
  });

  it("keeps one copy of a tariff shared by several EVSEs, with their connectors folded in", () => {
    const collector = createTariffCollector();
    collector.add([ccs()], [tariff(0.46)]);
    collector.add([ccs()], [tariff(0.46)]);
    collector.add([type2()], [tariff(0.4)]);

    const tariffs = collector.build([ccs(), ccs(), type2()]);
    expect(tariffs).toEqual([
      {
        ...tariff(0.46),
        appliesTo: [{ type: "CCS", powerKw: 60, currentType: "DC", quantity: 2 }],
      },
      {
        ...tariff(0.4),
        appliesTo: [{ type: "Type 2", powerKw: 11, currentType: "AC", quantity: 1 }],
      },
    ]);
  });

  it("leaves a tariff covering every connector unstamped", () => {
    const collector = createTariffCollector();
    collector.add([ccs()], [tariff(0.46)]);
    collector.add([type2()], [tariff(0.46)]);

    expect(collector.build([ccs(), type2()])).toEqual([tariff(0.46)]);
  });

  it("stamps a tariff that covers only some of the connector groups", () => {
    const collector = createTariffCollector();
    collector.add([ccs()], [tariff(0.46)]);

    expect(collector.build([ccs(), type2()])).toEqual([
      {
        ...tariff(0.46),
        appliesTo: [{ type: "CCS", powerKw: 60, currentType: "DC", quantity: 1 }],
      },
    ]);
  });

  it("counts a connector once even when two of its tariff ids resolve to the same content", () => {
    const collector = createTariffCollector();
    const conn = ccs();
    collector.add([conn], [tariff(0.46), tariff(0.46)]);

    expect(collector.build([conn, type2()])?.[0].appliesTo).toEqual([
      { type: "CCS", powerKw: 60, currentType: "DC", quantity: 1 },
    ]);
  });

  it("does not fold tariffs that differ in content", () => {
    const collector = createTariffCollector();
    collector.add([ccs()], [tariff(0.46), { ...tariff(0.46), isDirectPayment: true }]);

    expect(collector.build([ccs(), type2()])).toHaveLength(2);
  });

  it("drops live status and source references from the stamped groups", () => {
    const collector = createTariffCollector();
    collector.add([{ ...ccs(), status: "operational", reference: "evse-1" }], [tariff(0.46)]);

    expect(collector.build([ccs(), type2()])?.[0].appliesTo).toEqual([
      { type: "CCS", powerKw: 60, currentType: "DC", quantity: 1 },
    ]);
  });
});
