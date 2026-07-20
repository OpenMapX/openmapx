import { describe, expect, it } from "vitest";
import type {
  EvChargingPriceComponent,
  EvChargingStation,
  EvChargingTariff,
} from "../ev-charging.js";

describe("EvChargingTariff", () => {
  it("carries a tariff with energy component and scope, and compiles/reads back", () => {
    const energyComponent: EvChargingPriceComponent = {
      type: "energy",
      price: 0.35,
      currency: "EUR",
      vat: 19,
      stepSize: 0.1,
    };

    const tariff: EvChargingTariff = {
      elements: [energyComponent],
      scope: "evse",
      isDirectPayment: true,
      source: "ocpi-provider",
      sourceUrl: "https://example.com/tariffs",
      updatedAt: "2026-07-20T10:00:00Z",
    };

    expect(tariff.elements).toHaveLength(1);
    expect(tariff.elements[0].type).toBe("energy");
    expect(tariff.elements[0].price).toBe(0.35);
    expect(tariff.scope).toBe("evse");
    expect(tariff.isDirectPayment).toBe(true);
  });

  it("allows tariffs array on EvChargingStation", () => {
    const energyComponent: EvChargingPriceComponent = {
      type: "energy",
      price: 0.35,
      currency: "EUR",
    };

    const tariff: EvChargingTariff = {
      elements: [energyComponent],
      scope: "country",
      source: "test-source",
      updatedAt: "2026-07-20T10:00:00Z",
    };

    const station: EvChargingStation = {
      id: "ocm:12345",
      name: "Test Station",
      coordinates: [8.5, 47.5],
      sources: ["ocm"],
      connectors: [],
      tariffs: [tariff],
    };

    expect(station.tariffs).toBeDefined();
    expect(station.tariffs).toHaveLength(1);
    expect(station.tariffs?.[0].scope).toBe("country");
  });
});
