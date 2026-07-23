import { describe, expect, it } from "vitest";
import { buildEvseUidToTariffIds, buildTariffMapById, mapOcpdbTariff } from "../de-ocpdb-tariff.js";

describe("de-ocpdb tariff", () => {
  it("maps an ENERGY component with VAT from taxes[]", () => {
    const tariffs = mapOcpdbTariff({
      currency: "EUR",
      type: "AD_HOC_PAYMENT",
      original_id: "DE*EBW*E1*1:adHoc",
      elements: [
        {
          price_components: [
            { type: "ENERGY", price: 0.66, taxes: [{ name: "VAT", percentage: "19" }] },
          ],
        },
      ],
    });
    expect(tariffs).toHaveLength(1);
    expect(tariffs[0]).toMatchObject({
      source: "de-ocpdb",
      isDirectPayment: true,
      elements: [{ type: "energy", price: 0.66, currency: "EUR", vat: 19 }],
    });
  });

  it("splits a base energy price and a duration-gated blocking fee into separate tariffs", () => {
    const tariffs = mapOcpdbTariff({
      currency: "EUR",
      type: "AD_HOC_PAYMENT",
      original_id: "DE*EBW*E1*1:adHoc",
      elements: [
        { price_components: [{ type: "ENERGY", price: 0.588 }] },
        {
          price_components: [{ type: "TIME", price: 0.1 }],
          restrictions: { min_duration: 7200, max_duration: 0 },
        },
      ],
    });
    expect(tariffs).toHaveLength(2);
    const energy = tariffs.find((t) => t.elements[0].type === "energy");
    const time = tariffs.find((t) => t.elements[0].type === "time");
    // The energy price must NOT inherit the blocking-fee condition.
    expect(energy?.restrictions).toBeUndefined();
    // 7200s → 120 min; the `0` max_duration is treated as unset.
    expect(time?.restrictions).toMatchObject({ minDurationMinutes: 120 });
    expect(time?.restrictions?.maxDurationMinutes).toBeUndefined();
  });

  it("returns an empty array when no priceable components remain", () => {
    expect(
      mapOcpdbTariff({ currency: "EUR", elements: [{ price_components: [{ type: "REGULAR" }] }] }),
    ).toEqual([]);
  });
});

describe("buildTariffMapById", () => {
  it("keys tariffs by their id", () => {
    const map = buildTariffMapById([
      {
        id: "78893",
        currency: "EUR",
        type: "AD_HOC_PAYMENT",
        elements: [{ price_components: [{ type: "ENERGY", price: 0.56 }] }],
      },
    ]);
    expect(map.has("78893")).toBe(true);
    expect(map.get("78893")?.[0].elements[0].price).toBe(0.56);
  });

  it("coerces a numeric id to a string key", () => {
    const map = buildTariffMapById([
      {
        id: 42,
        currency: "EUR",
        elements: [{ price_components: [{ type: "ENERGY", price: 0.3 }] }],
      },
    ]);
    expect(map.has("42")).toBe(true);
  });
});

describe("buildEvseUidToTariffIds", () => {
  it("maps each evse_uid to its association's tariff_id and skips empty-evses rows", () => {
    const map = buildEvseUidToTariffIds([
      { tariff_id: "1", evses: [{ evse_uid: "100" }, { evse_uid: "101" }] },
      { tariff_id: "2", evses: [{ evse_uid: "100" }] },
      { tariff_id: "3", evses: [] },
      { tariff_id: "4" },
    ]);
    expect([...(map.get("100") ?? [])].sort()).toEqual(["1", "2"]);
    expect([...(map.get("101") ?? [])]).toEqual(["1"]);
    expect(map.has("nope")).toBe(false);
  });
});
