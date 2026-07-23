import { describe, expect, it } from "vitest";
import {
  mapOcpiPriceComponentType,
  mapOcpiRestrictions,
  splitOcpiTariffElements,
} from "../ocpi-tariff.js";

describe("mapOcpiPriceComponentType", () => {
  it("maps the four known dimensions and drops unknown types", () => {
    expect(mapOcpiPriceComponentType("ENERGY")).toBe("energy");
    expect(mapOcpiPriceComponentType("TIME")).toBe("time");
    expect(mapOcpiPriceComponentType("FLAT")).toBe("flat");
    expect(mapOcpiPriceComponentType("PARKING_TIME")).toBe("parking");
    expect(mapOcpiPriceComponentType("REGULAR")).toBeUndefined();
  });
});

describe("mapOcpiRestrictions", () => {
  it("maps power and time-of-day and treats 0 duration as unset", () => {
    expect(
      mapOcpiRestrictions({
        start_time: "00:00",
        end_time: "07:00",
        min_power: 11,
        max_power: 50,
        min_duration: 0,
        max_duration: 0,
      }),
    ).toEqual({
      timeOfDayStart: "00:00",
      timeOfDayEnd: "07:00",
      minPowerKw: 11,
      maxPowerKw: 50,
    });
  });

  it("maps positive durations from seconds to minutes", () => {
    expect(mapOcpiRestrictions({ min_duration: 7200, max_duration: 300 })).toEqual({
      minDurationMinutes: 120,
      maxDurationMinutes: 5,
    });
  });

  it("returns undefined when nothing is restricted", () => {
    expect(mapOcpiRestrictions(null)).toBeUndefined();
    expect(mapOcpiRestrictions({ min_duration: 0, max_duration: 0 })).toBeUndefined();
  });
});

describe("splitOcpiTariffElements", () => {
  const vatOf = (c: { vat?: number | null }) => (typeof c.vat === "number" ? c.vat : undefined);

  it("splits elements with differing restrictions into separate groups", () => {
    const groups = splitOcpiTariffElements(
      [
        { price_components: [{ type: "ENERGY", price: 0.48, vat: 21 }] },
        {
          price_components: [{ type: "PARKING_TIME", price: 0.05 }],
          restrictions: { max_duration: 300 },
        },
      ],
      "EUR",
      vatOf,
    );
    expect(groups).toHaveLength(2);
    expect(groups[0]).toEqual({
      restrictions: undefined,
      elements: [{ type: "energy", price: 0.48, currency: "EUR", vat: 21, stepSize: undefined }],
    });
    expect(groups[1].restrictions).toEqual({ maxDurationMinutes: 5 });
    expect(groups[1].elements[0].type).toBe("parking");
  });

  it("merges elements that share an identical restriction into one group", () => {
    const groups = splitOcpiTariffElements(
      [
        { price_components: [{ type: "ENERGY", price: 0.3 }], restrictions: { max_power: 22 } },
        { price_components: [{ type: "TIME", price: 0.1 }], restrictions: { max_power: 22 } },
      ],
      "EUR",
      vatOf,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].elements.map((e) => e.type)).toEqual(["energy", "time"]);
  });

  it("skips elements with no priceable component", () => {
    const groups = splitOcpiTariffElements(
      [{ price_components: [{ type: "REGULAR", price: 999 }] }],
      "EUR",
      vatOf,
    );
    expect(groups).toEqual([]);
  });
});
