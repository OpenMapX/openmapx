import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildTariffMapByEvseId,
  mapOcpdbTariff,
  tariffStemFromOriginalId,
} from "../de-ocpdb-tariff.js";

const tariffs = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("./fixtures/de-ocpdb-tariffs.json", import.meta.url)),
    "utf-8",
  ),
).items;

describe("de-ocpdb tariff", () => {
  it("strips the :suffix to the evse_id stem", () => {
    expect(tariffStemFromOriginalId("DE*EBW*E914082*2:adHoc")).toBe("DE*EBW*E914082*2");
    expect(tariffStemFromOriginalId("DE*EBW*E914082*2")).toBe("DE*EBW*E914082*2");
  });

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

  it("builds a map keyed by evse_id stem from the fixture", () => {
    const map = buildTariffMapByEvseId(tariffs);
    expect(map.size).toBeGreaterThan(0);
    for (const key of map.keys()) expect(key).not.toContain(":");
  });
});
